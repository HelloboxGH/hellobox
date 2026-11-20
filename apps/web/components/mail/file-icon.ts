import {
  File, FileArchive, FileAudio, FileCode, FileCsv, FileDoc, FileHtml, FileImage, FilePdf, FilePpt, FileText, FileVideo,
  FileXls, type Icon,
} from "@phosphor-icons/react";

const BY_EXTENSION: Record<string, Icon> = {
  pdf: FilePdf,
  doc: FileDoc, docx: FileDoc, odt: FileDoc, rtf: FileDoc, pages: FileDoc,
  xls: FileXls, xlsx: FileXls, ods: FileXls, numbers: FileXls,
  ppt: FilePpt, pptx: FilePpt, odp: FilePpt, key: FilePpt,
  csv: FileCsv, tsv: FileCsv,
  zip: FileArchive, rar: FileArchive, "7z": FileArchive, tar: FileArchive, gz: FileArchive, tgz: FileArchive,
  bz2: FileArchive, xz: FileArchive,
  html: FileHtml, htm: FileHtml,
  txt: FileText, md: FileText, log: FileText, eml: FileText, ics: FileText, vcf: FileText,
  js: FileCode, ts: FileCode, jsx: FileCode, tsx: FileCode, json: FileCode, xml: FileCode, yml: FileCode,
  yaml: FileCode, css: FileCode, py: FileCode, rb: FileCode, go: FileCode, rs: FileCode, java: FileCode,
  sh: FileCode, sql: FileCode,
};

// The icon for an attachment's type: its content type's family first (image, video,
// audio), then its extension, since senders often label everything octet-stream.
export function fileIcon(filename: string, contentType = ""): Icon {
  const family = contentType.split("/")[0];
  if (family === "image") return FileImage;
  if (family === "video") return FileVideo;
  if (family === "audio") return FileAudio;
  if (contentType === "application/pdf") return FilePdf;
  const extension = filename.includes(".") ? filename.split(".").pop()!.toLowerCase() : "";
  if (/^(png|jpe?g|gif|webp|heic|heif|avif|bmp|tiff?|svg|ico)$/.test(extension)) return FileImage;
  if (/^(mp4|mov|webm|mkv|avi|m4v)$/.test(extension)) return FileVideo;
  if (/^(mp3|wav|m4a|aac|ogg|flac|opus)$/.test(extension)) return FileAudio;
  return BY_EXTENSION[extension] ?? (family === "text" ? FileText : File);
}
