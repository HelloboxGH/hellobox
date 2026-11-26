'use strict'

// HelloBox's Haraka plugin. The mail server keeps no mail and decides nothing itself:
// - RCPT TO: asks HelloBox whether to take mail for the address (cached briefly). With the
//   workspace's bounces on, an address with no mailbox is refused here (550 5.1.1), so the
//   sender's own server tells them and we never send a bounce ourselves;
// - queue: posts the raw message and its envelope, and answers the sender with HelloBox's
//   result. 250 only once HelloBox has stored it; otherwise 451, so the sender retries.
// Everything sent is signed with MX_SIGNING_KEY, the same way packages/mail/src/mx.ts checks.
//
// Haraka gives plugins OK, DENY, DENYSOFT and DENYSOFTDISCONNECT as globals.

const crypto = require('node:crypto')

const CACHE_MS = 60_000
const CACHE_MAX = 10_000
// Per connecting IP, counted at MAIL FROM. Large senders share IPs: watch this in the beta.
const PER_IP_PER_MINUTE = 20
// Refusing unknown addresses tells whoever asks which ones exist, so guessing is limited:
// an IP that names this many unknown addresses in the window is cut off and told to retry.
const UNKNOWN_PER_IP = 10
const UNKNOWN_WINDOW_MS = 10 * 60_000
const RECIPIENT_TIMEOUT_MS = 10_000
const MESSAGE_TIMEOUT_MS = 120_000

// Answers HelloBox said hold for a whole domain, and those for one address.
const domains = new Map()
const addresses = new Map()
const senders = new Map()
const guesses = new Map()

// 550 5.1.1 through Haraka's own DSN helper when it's there (it always is in Haraka).
function noSuchUser() {
  try {
    return require('haraka-dsn').no_such_user('No such user here')
  } catch {
    return 'No such user here'
  }
}

function settings() {
  return {
    url: (process.env.HELLOBOX_URL || '').replace(/\/+$/, ''),
    key: process.env.MX_SIGNING_KEY || '',
    // Until this is "true", every recipient gets 451: the server can run and be tested
    // from outside without taking any mail.
    open: process.env.MX_OPEN === 'true',
  }
}

function sign(key, timestamp, path, envelope, body) {
  const digest = crypto.createHash('sha256').update(body).digest('hex')
  return crypto.createHmac('sha256', key).update(`${timestamp}\n${path}\n${envelope}\n${digest}`).digest('hex')
}

// Haraka runs plugins in a sandbox without AbortSignal, so a slow answer is given up on here.
function withTimeout(promise, ms) {
  let timer
  const timeout = new Promise((resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`no answer after ${ms} ms`)), ms)
  })
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer))
}

async function call(config, path, body, envelope, timeout) {
  const timestamp = String(Math.floor(Date.now() / 1000))
  const headers = {
    'content-type': envelope ? 'message/rfc822' : 'application/json',
    'x-hellobox-timestamp': timestamp,
    'x-hellobox-signature': sign(config.key, timestamp, path, envelope, body),
  }
  if (envelope) headers['x-hellobox-envelope'] = envelope
  return withTimeout(fetch(`${config.url}${path}`, { method: 'POST', headers, body, redirect: 'error' }), timeout)
}

function remember(cache, key, value, now) {
  if (cache.size >= CACHE_MAX) cache.clear()
  cache.set(key, { ...value, expires: now + CACHE_MS })
}

// HelloBox's answer for an address: { accept, scope }. A "domain" answer holds for every
// address there (the domain isn't ours, or the workspace takes unknown addresses into Spam).
// For one address only a yes is kept: a mailbox made a moment ago must take its first mail,
// and a mailbox removed meanwhile only sends that minute's mail to Spam.
async function decide(config, address, domain, now = Date.now()) {
  for (const cached of [domains.get(domain), addresses.get(address)]) {
    if (cached && cached.expires > now) return { accept: cached.accept, scope: cached.scope }
  }
  const response = await call(config, '/api/mx/v1/recipients', Buffer.from(JSON.stringify({ recipient: address })), '', RECIPIENT_TIMEOUT_MS)
  if (!response.ok) throw new Error(`HelloBox answered ${response.status}`)
  const body = await response.json()
  const decision = { accept: body.accept === true, scope: body.scope === 'domain' ? 'domain' : 'address' }
  if (decision.scope === 'domain') remember(domains, domain, decision, now)
  else if (decision.accept) remember(addresses, address, decision, now)
  return decision
}

// Unknown addresses this IP named recently.
function recentGuesses(ip, now) {
  const recent = (guesses.get(ip) || []).filter((at) => at > now - UNKNOWN_WINDOW_MS)
  if (recent.length) guesses.set(ip, recent)
  else guesses.delete(ip)
  return recent
}

// True while this IP may still name addresses.
const mayGuess = (ip, now = Date.now()) => recentGuesses(ip, now).length < UNKNOWN_PER_IP

function guessedWrong(ip, now = Date.now()) {
  const recent = recentGuesses(ip, now)
  if (guesses.size >= CACHE_MAX && !guesses.has(ip)) guesses.clear()
  recent.push(now)
  guesses.set(ip, recent)
}

// True when this IP may start another message now.
function allowSender(ip, now = Date.now()) {
  const recent = (senders.get(ip) || []).filter((at) => at > now - 60_000)
  if (recent.length >= PER_IP_PER_MINUTE) {
    senders.set(ip, recent)
    return false
  }
  recent.push(now)
  if (senders.size >= CACHE_MAX && !senders.has(ip)) senders.clear()
  senders.set(ip, recent)
  return true
}

// HelloBox's answer, as what to tell the sender.
function outcome(status) {
  if (status >= 200 && status < 300) return 'ok'
  if (status === 422) return 'deny'
  return 'retry'
}

// user@host, with the domain in ASCII (punycode), as HelloBox stores domains. Haraka 3.4's
// @haraka/email-address has user and host properties; a null sender (<>) has neither.
function addressOf(value) {
  if (!value || !value.user || !value.host) return ''
  return `${value.user}@${value.host}`.toLowerCase()
}

exports.hook_mail = function (next, connection) {
  if (!allowSender(connection.remote.ip)) return next(DENYSOFT, 'Too many messages, try again later')
  next()
}

exports.hook_rcpt = function (next, connection, params) {
  const config = settings()
  if (!config.open || !config.url || !config.key) return next(DENYSOFT, 'Not accepting mail yet, try again later')
  const recipient = params[0]
  const address = addressOf(recipient)
  const domain = (recipient && recipient.host ? recipient.host : '').toLowerCase()
  if (!address || !domain) return next(DENY, 'Bad recipient')
  const ip = connection.remote.ip
  if (!mayGuess(ip)) return next(DENYSOFTDISCONNECT, 'Too many unknown recipients, try again later')
  decide(config, address, domain)
    .then(({ accept, scope }) => {
      if (accept) return next(OK)
      if (scope === 'domain') return next(DENY, 'No mailbox here for that domain')
      guessedWrong(ip)
      next(DENY, noSuchUser())
    })
    .catch((error) => {
      connection.logerror(this, `recipient check failed: ${error.message}`)
      next(DENYSOFT, 'Try again later')
    })
}

exports.hook_queue = function (next, connection) {
  const config = settings()
  const transaction = connection.transaction
  if (!config.open || !config.url || !config.key || !transaction) return next(DENYSOFT, 'Try again later')
  const envelope = Buffer.from(
    JSON.stringify({
      recipients: transaction.rcpt_to.map(addressOf).filter(Boolean),
      mailFrom: addressOf(transaction.mail_from),
      ip: connection.remote.ip,
      helo: (connection.hello && connection.hello.host) || '',
    }),
  ).toString('base64url')
  transaction.message_stream.get_data((raw) => {
    call(config, '/api/mx/v1/messages', raw, envelope, MESSAGE_TIMEOUT_MS)
      .then((response) => {
        const result = outcome(response.status)
        if (result === 'ok') return next(OK, 'Delivered to HelloBox')
        if (result === 'deny') return next(DENY, 'No mailbox here for that domain')
        connection.logwarn(this, `HelloBox answered ${response.status}`)
        next(DENYSOFT, 'Try again later')
      })
      .catch((error) => {
        connection.logerror(this, `delivery failed: ${error.message}`)
        next(DENYSOFT, 'Try again later')
      })
  })
}

// For the tests.
exports._internal = { sign, decide, allowSender, outcome, domains, addresses, senders, guesses }
