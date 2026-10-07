import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmod, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const root = fileURLToPath(new URL("../", import.meta.url));
const local = join(root, ".local");
const data = join(local, "postgres");
const socket = join(local, "postgres-socket");
const credentialsPath = join(local, "database-credentials.json");
const port = 55432;
const action = process.argv[2] ?? "start";
if (!["start", "stop", "status"].includes(action)) throw new Error("Use start, stop, or status.");

function run(program, args, environment = {}) {
  try {
    return execFileSync(program, args, {
      cwd: root,
      env: { ...process.env, ...environment },
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error) {
    throw new Error(
      `${program} failed. ${error.stderr?.toString().trim() ?? "Install PostgreSQL 17+ and ensure its tools are on PATH."}`,
    );
  }
}

async function exists(path) {
  try {
    await readFile(path);
    return true;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}

async function writeEnvironment(path, values) {
  let current = "";
  try {
    current = await readFile(path, "utf8");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  for (const [key, value] of Object.entries(values)) {
    const existing = current.match(new RegExp(`^${key}=(.*)$`, "m"));
    if (existing && existing[1].trim() !== "") continue;
    if (existing) current = current.replace(new RegExp(`^${key}=.*$`, "m"), `${key}=${value}`);
    else current += `${current && !current.endsWith("\n") ? "\n" : ""}${key}=${value}\n`;
  }
  await writeFile(path, current, { mode: 0o600 });
  await chmod(path, 0o600);
}

try {
  if (action !== "start") {
    if (!(await exists(join(data, "PG_VERSION"))))
      throw new Error("No MandatePay local database has been initialized.");
    console.log(
      run(
        "pg_ctl",
        action === "stop" ? ["-D", data, "-m", "fast", "stop"] : ["-D", data, "status"],
      ).trim(),
    );
  } else {
    await mkdir(local, { recursive: true, mode: 0o700 });
    await mkdir(socket, { recursive: true, mode: 0o700 });
    let credentials;
    if (await exists(credentialsPath))
      credentials = JSON.parse(await readFile(credentialsPath, "utf8"));
    else {
      if (await exists(join(data, "PG_VERSION")))
        throw new Error(
          "Database exists but its local credentials file is missing; do not reinitialize it.",
        );
      credentials = { user: "mandatepay", password: randomBytes(32).toString("hex") };
      await writeFile(credentialsPath, JSON.stringify(credentials), { flag: "wx", mode: 0o600 });
    }
    if (credentials.user !== "mandatepay" || !/^[a-f0-9]{64}$/.test(credentials.password))
      throw new Error("Invalid local database credentials metadata.");
    if (!(await exists(join(data, "PG_VERSION")))) {
      await mkdir(data, { recursive: true, mode: 0o700 });
      if ((await readdir(data)).length)
        throw new Error("The local database directory is not empty; refusing to overwrite it.");
      const passwordFile = join(local, "initdb-password.tmp");
      try {
        await writeFile(passwordFile, `${credentials.password}\n`, { flag: "wx", mode: 0o600 });
        run("initdb", [
          "-D",
          data,
          "-U",
          credentials.user,
          "--auth=scram-sha-256",
          "--pwfile",
          passwordFile,
          "--encoding=UTF8",
          "--locale=C",
        ]);
      } finally {
        await rm(passwordFile, { force: true });
      }
    }
    let running = false;
    try {
      run("pg_ctl", ["-D", data, "status"]);
      running = true;
    } catch {
      /* Start this cluster only. */
    }
    if (!running) {
      const quotedSocket = `'${socket.replaceAll("'", "'\\''")}'`;
      run("pg_ctl", [
        "-D",
        data,
        "-l",
        join(local, "postgres.log"),
        "-o",
        `-h 127.0.0.1 -p ${port} -k ${quotedSocket}`,
        "-w",
        "start",
      ]);
    }
    const pgEnvironment = {
      PGHOST: "127.0.0.1",
      PGPORT: String(port),
      PGUSER: credentials.user,
      PGPASSWORD: credentials.password,
    };
    for (const database of ["mandatepay", "mandatepay_test"]) {
      const found = run(
        "psql",
        ["-d", "postgres", "-tAc", `SELECT 1 FROM pg_database WHERE datname = '${database}'`],
        pgEnvironment,
      ).trim();
      if (found !== "1") run("createdb", [database], pgEnvironment);
    }
    const url = (database) =>
      `postgresql://${credentials.user}:${credentials.password}@127.0.0.1:${port}/${database}?schema=public`;
    await mkdir(join(root, "packages/database"), { recursive: true });
    await writeEnvironment(join(root, "apps/api/.env"), {
      DATABASE_URL: url("mandatepay"),
      TEST_DATABASE_URL: url("mandatepay_test"),
      AUTH_SECRET: randomBytes(32).toString("base64url"),
      APP_URL: "http://localhost:3000",
      API_URL: "http://localhost:4000",
      ADMIN_ORIGIN: "http://localhost:3001",
      OPENAI_API_KEY: "",
      OPENAI_MODEL: "",
      OPENAI_BASE_URL: "https://api.openai.com/v1",
      CHANNEL3_API_KEY: "",
      PAYPAL_ENV: "sandbox",
      PAYPAL_CLIENT_ID: "",
      PAYPAL_CLIENT_SECRET: "",
      PAYPAL_WEBHOOK_ID: "",
    });
    await writeEnvironment(join(root, "packages/database/.env"), {
      DATABASE_URL: url("mandatepay"),
      TEST_DATABASE_URL: url("mandatepay_test"),
    });
    console.log(`Dedicated PostgreSQL is ready at 127.0.0.1:${port}.`);
    console.log(
      "Development/test database settings saved in ignored 0600 environment files. Existing nonempty settings were preserved.",
    );
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
