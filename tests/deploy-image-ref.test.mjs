import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const digest = `sha256:${"a".repeat(64)}`;
const ghcr = /^ghcr\.io\/jjgitt\/junjunorder@sha256:[a-f0-9]{64}$/;
const swr = /^swr\.cn-north-4\.myhuaweicloud\.com\/junjunorder\/junjunorder@sha256:[a-f0-9]{64}$/;

test("deploy script accepts the GHCR and Huawei SWR digest refs only", async () => {
  const deploy = await readFile(new URL("../deploy/ci/deploy.sh", import.meta.url), "utf8");
  assert.match(deploy, /ghcr_image='/);
  assert.match(deploy, /swr_image='/);
  assert.ok(deploy.includes("jjgitt/junjunorder"));
  assert.ok(deploy.includes("junjunorder/junjunorder"));
  assert.match(deploy, /registry_host=swr\.cn-north-4\.myhuaweicloud\.com/);
  assert.doesNotMatch(deploy, /SWR_PASSWORD\s*[:=]/);
  assert.equal(ghcr.test(`ghcr.io/jjgitt/junjunorder@${digest}`), true);
  assert.equal(swr.test(`swr.cn-north-4.myhuaweicloud.com/junjunorder/junjunorder@${digest}`), true);
  assert.equal(ghcr.test(`ghcr.io/other/repo@${digest}`), false);
  assert.equal(swr.test(`swr.cn-north-4.myhuaweicloud.com/other/junjunorder@${digest}`), false);
  assert.match(deploy, /prune_unused_project_images/);
  assert.match(deploy, /hongyun-order-app:latest/);
  assert.match(deploy, /docker image ls --no-trunc --format '\{\{\.ID\}\} \{\{\.Repository\}\}'/);
  assert.doesNotMatch(deploy, /docker image prune -/);
  assert.match(deploy, /pull_timeout_seconds=300/);
  assert.match(deploy, /pull_attempts=3/);
  assert.match(
    deploy,
    /timeout --signal=TERM --kill-after="\$\{pull_kill_after_seconds\}s" "\$\{pull_timeout_seconds\}s" docker pull "\$image"/,
  );
  assert.match(deploy, /Image pull failed; running service unchanged/);
});

test("workflow keeps GHCR publish and optional SWR mirror", async () => {
  const workflow = await readFile(new URL("../.github/workflows/ci-cd.yml", import.meta.url), "utf8");
  const rollback = await readFile(new URL("../deploy/ci/rollback/ghcr-20260915/ci-cd.yml", import.meta.url), "utf8");
  assert.match(workflow, /tags: ghcr\.io\/jjgitt\/junjunorder:sha-\$\{\{ github\.sha \}\}/);
  assert.match(workflow, /Mirror image to Huawei SWR/);
  assert.match(workflow, /provenance: false/);
  assert.match(workflow, /sbom: false/);
  assert.match(workflow, /--prefer-index=false/);
  assert.match(workflow, /REQUESTED_REGISTRY.*IMAGE_REGISTRY/);
  assert.match(workflow, /continue-on-error: true/);
  assert.match(workflow, /Huawei SWR is unavailable; deploying the identical digest from GHCR/);
  assert.match(workflow, /needs\.publish\.outputs\.registry == 'swr'/);
  assert.match(workflow, /swr\.cn-north-4\.myhuaweicloud\.com\/junjunorder\/junjunorder/);
  assert.match(workflow, /ghcr\.io\/jjgitt\/junjunorder/);
  assert.match(rollback, /"\$DEPLOY_USER@\$DEPLOY_HOST" "ghcr\.io\/jjgitt\/junjunorder@\$IMAGE_DIGEST"/);
  assert.doesNotMatch(workflow, /SWR_PASSWORD:\s*['"]?[A-Za-z0-9+/=]{20,}/);
});
