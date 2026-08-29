import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { AdminAuthService } from "../bridge/admin-auth.js";
import { InstallSettingsStore } from "../bridge/install-settings.js";
import { JobRepository } from "../bridge/job-repository.js";

const dataDir = mkdtempSync(path.join(tmpdir(), "h3-studio-setup-"));
const jobs = new JobRepository(dataDir);
const auth = new AdminAuthService(jobs.databasePath);
const defaults = {
  comfyUrl: "http://127.0.0.1:8188",
  comfyOutputDir: "C:\\ComfyUI\\output",
  videoWorkflowId: "h3-aio-ultra",
  fastWorkflowId: "h3-fast-alibaba-pdd",
  imageWorkflowId: "krea2-character-sheet",
  imageEditWorkflowId: "flux2-klein-edit-core",
  imageAnimaWorkflowId: "anima-t2i-core",
  imageMinimaxWorkflowId: "minimax-h3-image-aio",
  ffmpegPath: "ffmpeg",
};

try {
  assert.equal(auth.isConfigured(), false);
  assert.throws(() => auth.createPassword("short"), /10 e 200/);
  auth.createPassword("correct horse battery staple");
  assert.equal(auth.isConfigured(), true);
  assert.equal(auth.verifyPassword("wrong password"), false);
  assert.equal(auth.verifyPassword("correct horse battery staple"), true);
  const token = auth.createSession();
  assert.equal(auth.isAuthenticated(`h3_admin_session=${encodeURIComponent(token)}`), true);
  auth.revoke(`h3_admin_session=${encodeURIComponent(token)}`);
  assert.equal(auth.isAuthenticated(`h3_admin_session=${encodeURIComponent(token)}`), false);

  const settingsStore = new InstallSettingsStore(dataDir, defaults);
  assert.deepEqual(await settingsStore.get(), defaults);
  const updated = await settingsStore.update({
    ...defaults,
    comfyUrl: "http://localhost:9000/",
  });
  assert.equal(updated.comfyUrl, "http://localhost:9000");
  assert.deepEqual(await settingsStore.get(), updated);
  await assert.rejects(
    () => settingsStore.update({ ...defaults, fastWorkflowId: "wrong" }),
    /Workflow fast non valido/,
  );
  console.log("First-run settings + Admin auth: OK");
} finally {
  auth.close();
  jobs.close();
  rmSync(dataDir, { recursive: true, force: true });
}
