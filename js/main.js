// Term Coder — entry point. Imports every module so its top-level side
// effects run (window.termCoder wiring, etc.), then starts the app.
import "./00-state.js";
import "./01-sessions.js";
import "./02-sqlite.js";
import "./03-history.js";
import "./04-dom.js";
import "./05-util.js";
import "./06-tools.js";
import "./07-spawn.js";
import "./08-settings.js";
import "./09-complexity.js";
import "./10-project-branch.js";
import "./11-projects.js";
import "./12-markdown.js";
import "./13-chat.js";
import "./14-models.js";
import "./15-tokens.js";
import "./16-attachments.js";
import "./17-system-prompt.js";
import "./18-send.js";
import "./19-autofollow.js";
import "./20-terminal.js";
import "./21-askchoice.js";
import "./22-resizers.js";
import "./23-userterm.js";
import { init } from "./24-init.js";
import { el } from "./04-dom.js";

init().catch((e) => {
  console.error(e);
  el.loading.textContent = "Failed to start: " + (e && e.message ? e.message : String(e));
});
