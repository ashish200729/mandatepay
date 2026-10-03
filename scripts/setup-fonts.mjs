import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";

const destination = fileURLToPath(
  new URL("../apps/web/fonts/satoshi-variable.woff2", import.meta.url),
);
const cssUrl = "https://api.fontshare.com/v2/css?f[]=satoshi@variable&display=swap";

function validateFont(data) {
  if (
    data.length < 10_000 ||
    data.length > 1_048_576 ||
    data.subarray(0, 4).toString() !== "wOF2"
  ) {
    throw new Error("Fontshare did not return a valid bounded WOFF2 font.");
  }
}

async function download(url, maximumBytes) {
  const response = await fetch(url, { signal: AbortSignal.timeout(30_000), redirect: "error" });
  if (!response.ok || !response.body)
    throw new Error(`Fontshare download failed (${response.status}).`);
  const chunks = [];
  let length = 0;
  for await (const chunk of response.body) {
    length += chunk.length;
    if (length > maximumBytes) throw new Error("Fontshare response exceeded the size limit.");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

try {
  let existing;
  try {
    existing = await readFile(destination);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  if (existing) {
    validateFont(existing);
    console.log("Local Satoshi font is ready.");
  } else {
    console.log("Obtaining Satoshi directly from Fontshare under its ITF Free Font License.");
    console.log("License: https://www.fontshare.com/licenses/itf-ffl");
    const css = (await download(cssUrl, 100_000)).toString("utf8");
    const block = css
      .split("@font-face")
      .find(
        (entry) =>
          /font-weight:\s*300\s+900\s*;/.test(entry) && /font-style:\s*normal\s*;/.test(entry),
      );
    const match = block?.match(/url\(['"](\/\/cdn\.fontshare\.com\/[^'"]+\.woff2)['"]\)/);
    if (!match) throw new Error("Fontshare variable-font metadata could not be validated.");
    const url = new URL(`https:${match[1]}`);
    if (url.hostname !== "cdn.fontshare.com") throw new Error("Unexpected font download host.");
    const font = await download(url.href, 1_048_576);
    validateFont(font);
    await mkdir(new URL("../apps/web/fonts/", import.meta.url), { recursive: true });
    const temporary = `${destination}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, font, { flag: "wx" });
      await rename(temporary, destination);
    } finally {
      await rm(temporary, { force: true });
    }
    console.log("Satoshi is installed locally; its binary is excluded from Git.");
  }
} catch (error) {
  console.error(error.message);
  console.error(
    "Obtain the original Satoshi Variable WOFF2 from Fontshare and place it in apps/web/fonts/satoshi-variable.woff2, then retry.",
  );
  process.exitCode = 1;
}
