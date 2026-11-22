# Get a server ready

On this page you create the server, connect to it, make it safer, and install Docker. At
the end you have a server ready for HelloBox.

## Make an SSH key

An SSH key lets you connect to the server without typing a password, and it's much harder
to guess than a password. You make it once, on your own computer.

Open a terminal on your computer:

- **macOS:** open the **Terminal** app (search for it with Spotlight).
- **Windows 10 or 11:** open **Windows Terminal** or **PowerShell** from the Start menu.
- **Linux:** open your terminal app.

Check whether you already have a key:

```bash
cat ~/.ssh/id_ed25519.pub
```

If it prints one line starting with `ssh-ed25519`, you have one: skip to the next part.
If it says `No such file or directory`, make one:

```bash
ssh-keygen -t ed25519
```

Press Enter to accept the place it suggests, then choose a passphrase (a password for the
key) and type it twice. Run the `cat` command above again and copy the line it prints. That
is your *public* key; it's safe to share. Never share the file without `.pub`, which is
your private key.

## Create the server

At your hosting company, create a new server (it may be called a VPS, a droplet, an
instance or a cloud server) with:

- **Image or system:** Ubuntu 24.04 LTS.
- **Size:** at least 2 GB of memory and 20 GB of disk.
- **SSH key:** paste the public key you copied. Most companies ask for it here.

When it's ready, the control panel shows its **public IPv4 address**, four numbers like
`203.0.113.10`. Note it down. This guide calls it `<server-ip>`.

## Connect to it

In the terminal on your computer:

```bash
ssh root@<server-ip>
```

The first time, it asks `Are you sure you want to continue connecting?`. Type `yes` and
press Enter. If it asks for a passphrase, it's the one you chose for your key. You're in
when the line you type on starts with something like `root@your-server:~#`. Every command
from now on runs on the server.

To leave the server, type `exit`.

> If your hosting company gave you a user other than `root` (some do, such as `ubuntu`),
> connect with that name instead and skip the next part.

## Make your own user

Working as `root` means any typing mistake can break the whole system. Make an everyday
user, called `hellobox` here, that asks for a password before anything risky:

```bash
adduser hellobox
```

It asks for a password (type it twice; nothing shows while you type, that's normal), then
for a name and other details. Press Enter to skip those. Then give the user admin rights
and your SSH key:

```bash
usermod -aG sudo hellobox
rsync --archive --chown=hellobox:hellobox ~/.ssh /home/hellobox
```

Type `exit`, then connect as the new user:

```bash
ssh hellobox@<server-ip>
```

From now on, commands that start with `sudo` run with admin rights and may ask for the
`hellobox` user's password.

## Update the system

```bash
sudo apt update && sudo apt upgrade -y
```

This can take a few minutes. If it shows a pink or purple screen about services to
restart, press Enter to accept. If the server says a restart is needed, run `sudo reboot`,
wait a minute and connect again.

Ubuntu installs security updates by itself every day. Check that it's on:

```bash
systemctl status unattended-upgrades --no-pager
```

It should say `active (running)`.

## Turn on the firewall

A firewall blocks every port except the ones you open. HelloBox needs three: 22 for SSH,
80 and 443 for the web.

```bash
sudo ufw allow OpenSSH
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
sudo ufw enable
```

Type `y` when it warns that SSH connections may be interrupted. Your connection stays open
because you allowed SSH first. Check it:

```bash
sudo ufw status
```

It should list `OpenSSH`, `80/tcp` and `443/tcp` as `ALLOW`.

> Docker can open ports that skip this firewall. HelloBox's containers only listen on the
> server itself (`127.0.0.1`), so nothing gets past it. Some hosting companies also have a
> firewall in their control panel; if yours does, open the same three ports there.

## Install Docker

Install Docker from Docker's own package source, which stays up to date. These are the
steps from [Docker's guide for Ubuntu](https://docs.docker.com/engine/install/ubuntu/#install-using-the-repository);
if anything below fails, follow that page instead.

```bash
sudo apt install -y ca-certificates curl
sudo install -m 0755 -d /etc/apt/keyrings
sudo curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
sudo chmod a+r /etc/apt/keyrings/docker.asc
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo "$VERSION_CODENAME") stable" | sudo tee /etc/apt/sources.list.d/docker.list > /dev/null
sudo apt update
sudo apt install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
```

Let your user run Docker without `sudo`:

```bash
sudo usermod -aG docker $USER
```

Type `exit` and connect again with `ssh hellobox@<server-ip>`, so the change applies. Then
check that it works:

```bash
docker run --rm hello-world
docker compose version
```

The first prints `Hello from Docker!`. The second prints a version that must be 2.20 or
newer.

> Being in the `docker` group is the same as having admin rights on this server. Only add
> people you'd trust with `sudo`.

## Install Git

Git downloads HelloBox and its updates. Ubuntu usually has it already:

```bash
sudo apt install -y git
```

Your server is ready. Next: [Point your domain at the server](dns.md).
