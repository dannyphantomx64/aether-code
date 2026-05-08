// First-run / no-key setup flow.
//
// UX mirrors `gh auth login` / `railway login` / `npm login`:
//   1. Print a friendly explanation
//   2. Open the browser to https://trynoguard.com/account
//   3. Prompt the user to paste the ak_live_ key
//   4. Validate format + verify against /api/v1/me
//   5. Save to ~/.aetherrc with mode 0600
//
// If the user is in a non-TTY environment (CI, piped stdin), we skip the
// auto-open and just print clear instructions for AETHER_API_KEY env var.

import readline from "node:readline";
import { spawn } from "node:child_process";
import { writeConfigFile, CONFIG_PATH } from "./config.js";
import { fetchBalance, AetherError } from "./api.js";
import { c, errorLine } from "./render.js";

const ACCOUNT_URL = "https://trynoguard.com/account";
const SIGNUP_URL = "https://trynoguard.com/signup";

/**
 * Cross-platform "open this URL in the user's default browser".
 * Best-effort — if it fails (no GUI, blocked, etc.) we just continue.
 */
function openInBrowser(url) {
  try {
    const platform = process.platform;
    if (platform === "win32") {
      // The empty "" is the window title — required because cmd parses the
      // first quoted arg as the title otherwise.
      spawn("cmd", ["/c", "start", "", url], { detached: true, stdio: "ignore" }).unref();
    } else if (platform === "darwin") {
      spawn("open", [url], { detached: true, stdio: "ignore" }).unref();
    } else {
      spawn("xdg-open", [url], { detached: true, stdio: "ignore" }).unref();
    }
    return true;
  } catch {
    return false;
  }
}

function ask(rl, question) {
  return new Promise((resolve) => rl.question(question, (answer) => resolve(answer.trim())));
}

/**
 * Returns true if setup completed successfully (key saved + verified).
 * Returns false if the user gave up.
 */
export async function runSetup() {
  console.log("");
  console.log(c.bold(c.magenta("aether")) + c.gray(" — first-time setup"));
  console.log(c.gray("─".repeat(60)));
  console.log("");
  console.log("To use Aether, you need an API key tied to your account.");
  console.log("Keys start with " + c.cyan("ak_live_") + ".");
  console.log("");

  // Non-TTY — bail with instructions instead of prompting
  if (!process.stdin.isTTY) {
    console.log(errorLine("Can't run interactive setup (stdin isn't a TTY)."));
    console.log("");
    console.log("Options:");
    console.log(`  · Set ${c.cyan("AETHER_API_KEY")} env var to your ak_live_ key.`);
    console.log(`  · Or run ${c.cyan("aether config set <key>")} from a real terminal.`);
    console.log(`  · Get a key at ${c.blue(ACCOUNT_URL)}.`);
    console.log("");
    return false;
  }

  console.log(c.bold("Step 1: ") + "Open " + c.blue(ACCOUNT_URL) + " in your browser.");
  console.log(c.gray("        (no account yet? sign up free at " + SIGNUP_URL + ")"));

  const opened = openInBrowser(ACCOUNT_URL);
  if (opened) {
    console.log(c.gray("        ↪ opened it for you."));
  }
  console.log("");
  console.log(c.bold("Step 2: ") + "Click " + c.cyan("Generate API key") + " and copy the key shown.");
  console.log(c.gray("        (the key is shown ONCE — copy it before navigating away)"));
  console.log("");
  console.log(c.bold("Step 3: ") + "Paste the key below.");
  console.log("");

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

  // Up to 3 attempts at a valid key
  let saved = false;
  for (let attempt = 0; attempt < 3; attempt++) {
    const key = await ask(rl, c.magenta("API key: "));
    if (!key) {
      console.log(c.gray("(empty — skipping)"));
      break;
    }
    if (key.toLowerCase() === "q" || key.toLowerCase() === "quit") {
      console.log(c.gray("Cancelled."));
      break;
    }
    if (!key.startsWith("ak_live_")) {
      console.log(errorLine(`Keys start with ${c.cyan("ak_live_")} — that doesn't look right. Try again or type 'q' to cancel.`));
      continue;
    }
    if (key.length < 30) {
      console.log(errorLine("That key looks too short. Try copying again."));
      continue;
    }

    // Tentative save so the API client picks it up
    writeConfigFile({ apiKey: key });
    process.stdout.write(c.gray("Verifying..."));
    try {
      const me = await fetchBalance();
      console.log(c.green(" ✓"));
      console.log("");
      console.log(c.green(c.bold("Setup complete.")));
      console.log(
        c.gray(`Saved to ${CONFIG_PATH} (mode 0600).`) +
          c.gray(`\nPlan: ${me.plan} · Balance: ${me.balance.toLocaleString()} credits`),
      );
      console.log("");
      saved = true;
      break;
    } catch (err) {
      console.log(c.red(" ✗"));
      if (err instanceof AetherError && err.status === 401) {
        console.log(errorLine("Server rejected that key (401). Double-check you copied it correctly."));
      } else {
        console.log(errorLine(err.message || String(err)));
      }
      // Roll back the bad save so we don't leave a broken key on disk
      writeConfigFile({ apiKey: "" });
    }
  }

  rl.close();
  return saved;
}
