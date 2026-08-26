import fs from 'node:fs/promises';
import path from 'node:path';

export async function ensureDirectory(directory) {
  await fs.mkdir(directory, { recursive: true });
}

export async function exists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

export async function fetchBuffer(url, retries = 7) {
  let lastError;
  for (let attempt = 1; attempt <= retries; attempt += 1) {
    try {
      const response = await fetch(url, {
        headers: { 'user-agent': 'three-china-terrain-data-builder/0.1' },
      });
      if (!response.ok) {
        throw new Error(`${response.status} ${response.statusText}`);
      }
      return Buffer.from(await response.arrayBuffer());
    } catch (error) {
      lastError = error;
      if (attempt < retries) {
        await new Promise((resolve) => setTimeout(resolve, attempt * attempt * 500));
      }
    }
  }
  throw lastError;
}

export async function downloadToFile(url, filePath, { optional = false } = {}) {
  if (await exists(filePath)) {
    return { downloaded: false, filePath };
  }

  await ensureDirectory(path.dirname(filePath));
  try {
    const data = await fetchBuffer(url);
    await fs.writeFile(filePath, data);
    return { downloaded: true, filePath, bytes: data.byteLength };
  } catch (error) {
    if (optional) {
      console.warn(`Optional download skipped: ${url} (${error.message})`);
      return { downloaded: false, filePath, skipped: true };
    }
    throw error;
  }
}

export async function mapConcurrent(items, concurrency, worker) {
  const results = new Array(items.length);
  let cursor = 0;

  async function run() {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await worker(items[index], index);
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, run));
  return results;
}

export async function readJson(filePath) {
  return JSON.parse(await fs.readFile(filePath, 'utf8'));
}

export async function writeJson(filePath, value) {
  await ensureDirectory(path.dirname(filePath));
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}
