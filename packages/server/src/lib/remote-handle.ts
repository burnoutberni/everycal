import { domainToASCII } from "node:url";

export type ParsedRemoteHandle = { localPart: string; domain: string };

const LOCAL_PART_PATTERN = /^[A-Za-z0-9._-]+$/;
const HOST_PATTERN = /^(?=.{1,253}$)(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])$/;

export function parseRemoteHandle(value: string): ParsedRemoteHandle | null {
  const handle = value.trim();
  if (!handle || /\s/.test(handle)) return null;
  if (handle.includes("://") || handle.includes("/") || handle.includes("?") || handle.includes("#")) return null;

  const firstAt = handle.indexOf("@");
  const lastAt = handle.lastIndexOf("@");
  if (firstAt <= 0 || firstAt !== lastAt || firstAt >= handle.length - 1) return null;

  const localPart = handle.slice(0, firstAt);
  if (!LOCAL_PART_PATTERN.test(localPart)) return null;

  const rawHostPort = handle.slice(firstAt + 1);
  const colonCount = (rawHostPort.match(/:/g) || []).length;
  if (colonCount > 1) return null;

  const [rawHost, rawPort] = rawHostPort.split(":");
  if (!rawHost) return null;
  if (rawPort === "") return null;

  const host = domainToASCII(rawHost);
  if (!host || !HOST_PATTERN.test(host)) return null;

  if (rawPort == null) return { localPart, domain: host };

  if (!/^\d+$/.test(rawPort)) return null;
  const parsedPort = Number(rawPort);
  if (!Number.isInteger(parsedPort) || parsedPort < 1 || parsedPort > 65535) return null;

  return { localPart, domain: `${host}:${parsedPort}` };
}
