const encoder = new TextEncoder();
const decoder = new TextDecoder();

function bytesToBase64(bytes) {
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

function base64ToBytes(value) {
  const binary = atob(value);
  return Uint8Array.from(binary, char => char.charCodeAt(0));
}

export function base64UrlEncode(bytes) {
  return bytesToBase64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

export function base64UrlDecode(value) {
  const normalized = String(value).replace(/-/g, '+').replace(/_/g, '/');
  const padded = normalized + '='.repeat((4 - normalized.length % 4) % 4);
  return base64ToBytes(padded);
}

export function randomToken(size = 32) {
  const bytes = new Uint8Array(size);
  crypto.getRandomValues(bytes);
  return base64UrlEncode(bytes);
}

export async function sha256(value) {
  const bytes = typeof value === 'string' ? encoder.encode(value) : value;
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return base64UrlEncode(new Uint8Array(digest));
}

export async function hashPassword(password, iterations = 60000) {
  const salt = new Uint8Array(16);
  crypto.getRandomValues(salt);
  const key = await crypto.subtle.importKey('raw', encoder.encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt, iterations },
    key,
    256
  );
  return `pbkdf2-sha256$${iterations}$${base64UrlEncode(salt)}$${base64UrlEncode(new Uint8Array(bits))}`;
}

export async function verifyPassword(password, stored) {
  const parts = String(stored || '').split('$');
  if (parts.length !== 4 || parts[0] !== 'pbkdf2-sha256') return false;
  const iterations = Number(parts[1]);
  const salt = base64UrlDecode(parts[2]);
  const expected = base64UrlDecode(parts[3]);
  const key = await crypto.subtle.importKey('raw', encoder.encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = new Uint8Array(await crypto.subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt, iterations },
    key,
    expected.length * 8
  ));
  if (bits.length !== expected.length) return false;
  let diff = 0;
  for (let index = 0; index < bits.length; index += 1) diff |= bits[index] ^ expected[index];
  return diff === 0;
}

async function encryptionKey(secret) {
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(String(secret || '')));
  return crypto.subtle.importKey('raw', digest, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}

export async function sealText(plainText, secret) {
  if (!plainText) return '';
  const iv = new Uint8Array(12);
  crypto.getRandomValues(iv);
  const key = await encryptionKey(secret);
  const encrypted = new Uint8Array(await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    key,
    encoder.encode(String(plainText))
  ));
  return `v1.${base64UrlEncode(iv)}.${base64UrlEncode(encrypted)}`;
}

export async function openText(cipherText, secret) {
  if (!cipherText) return '';
  const parts = String(cipherText).split('.');
  if (parts.length !== 3 || parts[0] !== 'v1') return '';
  try {
    const key = await encryptionKey(secret);
    const plain = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: base64UrlDecode(parts[1]) },
      key,
      base64UrlDecode(parts[2])
    );
    return decoder.decode(plain);
  } catch {
    return '';
  }
}
