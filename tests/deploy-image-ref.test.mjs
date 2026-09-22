import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const digest = `sha256:${"a".repeat(64)}`;
const ghcr = /^ghcr\.io\/jjgitt\/junjunorder@sha256:[a-f0-9]{64}$/;
const swr = /^swr\.cn-north-4\.myhuaweicloud\.com\/junjunorder\/junjunorder@sha256:[a-f0-9]{64}$/;
const acr = /^crpi-lz061y1f8ajv9wzf\.cn-guangzhou\.personal\.cr\.aliyuncs\.com\/junjunorder\/junjunorder@sha256:[a-f0-9]{64}$/;
const acrRepository = "crpi-lz061y1f8ajv9wzf.cn-guangzhou.personal.cr.aliyuncs.com/junjunorder/junjunorder";

test("deploy script accepts the GHCR, Huawei SWR and Aliyun ACR digest refs only", async () => {
  const deploy = await readFile(new URL("../deploy/ci/deploy.sh", import.meta.url), "utf8");
  assert.match(deploy, /ghcr_image='/);
  assert.match(deploy, /swr_image='/);
  assert.match(deploy, /acr_image='/);
  assert.ok(deploy.includes("jjgitt/junjunorder"));
  assert.ok(deploy.includes("junjunorder/junjunorder"));
  assert.match(deploy, /registry_host=swr\.cn-north-4\.myhuaweicloud\.com/);
  assert.match(deploy, /registry_host=crpi-lz061y1f8ajv9wzf\.cn-guangzhou\.personal\.cr\.aliyuncs\.com/);
  assert.ok(deploy.includes(`$2 == "${acrRepository}"`), "housekeeping prunes stale ACR digests too");
  assert.match(deploy, /\$current_ref" =~ \$acr_image/);
  assert.doesNotMatch(deploy, /SWR_PASSWORD\s*[:=]/);
  assert.doesNotMatch(deploy, /ACR_PASSWORD\s*[:=]/);
  assert.equal(ghcr.test(`ghcr.io/jjgitt/junjunorder@${digest}`), true);
  assert.equal(swr.test(`swr.cn-north-4.myhuaweicloud.com/junjunorder/junjunorder@${digest}`), true);
  assert.equal(acr.test(`${acrRepository}@${digest}`), true);
  assert.equal(ghcr.test(`ghcr.io/other/repo@${digest}`), false);
  assert.equal(swr.test(`swr.cn-north-4.myhuaweicloud.com/other/junjunorder@${digest}`), false);
  assert.equal(acr.test(`crpi-other.cn-guangzhou.personal.cr.aliyuncs.com/junjunorder/junjunorder@${digest}`), false);
  // Aliyun ACR usernames are account login names, so the stdin credential check must allow email-like values.
  assert.match(deploy, /\[\[ "\$registry_user" =~ \^\[\^\[:space:\]\[:cntrl:\]\]\+\$ && \$\{#registry_user\} -le 128 && -n "\$registry_token" \]\] \|\| exit 64/);
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

test("workflow copies ACR from SWR and deploys ACR then SWR then GHCR", async () => {
  const workflow = await readFile(new URL("../.github/workflows/ci-cd.yml", import.meta.url), "utf8");
  const rollback = await readFile(new URL("../deploy/ci/rollback/ghcr-20260915/ci-cd.yml", import.meta.url), "utf8");
  assert.match(workflow, /tags: ghcr\.io\/jjgitt\/junjunorder:sha-\$\{\{ github\.sha \}\}/);
  assert.match(workflow, /Login to Huawei SWR/);
  assert.match(workflow, /Mirror image to Huawei SWR/);
  assert.match(workflow, /Login to Aliyun ACR/);
  assert.match(workflow, /Mirror image to Aliyun ACR/);
  assert.match(workflow, /if: \$\{\{ vars\.SWR_REPOSITORY != '' && steps\.swr_login\.outcome == 'success' \}\}/);
  assert.match(
    workflow,
    /if: \$\{\{ vars\.ACR_REPOSITORY != '' && steps\.acr_login\.outcome == 'success' && steps\.swr_mirror\.outcome == 'success' \}\}/,
  );
  assert.match(workflow, /\$SWR_HOST\/\$SWR_REPOSITORY@\$IMAGE_DIGEST/);
  assert.match(workflow, /Copying ACR from Huawei SWR/);
  assert.match(workflow, /provenance: false/);
  assert.match(workflow, /sbom: false/);
  assert.match(workflow, /--prefer-index=false/);
  assert.match(workflow, /REQUESTED_REGISTRY.*IMAGE_REGISTRY/);
  assert.match(workflow, /continue-on-error: true/);
  assert.match(workflow, /order='acr swr'/);
  assert.match(workflow, /Aliyun ACR is unavailable; deploying the identical digest from Huawei SWR/);
  assert.match(workflow, /Aliyun ACR and Huawei SWR are unavailable; deploying the identical digest from GHCR/);
  assert.match(workflow, /echo "repository=\$repository" >> "\$GITHUB_OUTPUT"/);
  assert.match(workflow, /IMAGE_REPOSITORY: \$\{\{ needs\.publish\.outputs\.repository \|\| 'ghcr\.io\/jjgitt\/junjunorder' \}\}/);
  assert.match(workflow, /needs\.publish\.outputs\.registry == 'swr' && secrets\.SWR_USERNAME/);
  assert.match(workflow, /needs\.publish\.outputs\.registry == 'acr' && secrets\.ACR_USERNAME/);
  assert.match(workflow, /needs\.publish\.outputs\.registry == 'swr' && secrets\.SWR_PASSWORD/);
  assert.match(workflow, /needs\.publish\.outputs\.registry == 'acr' && secrets\.ACR_PASSWORD/);
  assert.match(workflow, /swr\\\.cn-north-4\\\.myhuaweicloud\\\.com\/junjunorder\/junjunorder/, "deploy job whitelists the SWR repository");
  assert.match(workflow, /crpi-lz061y1f8ajv9wzf\\\.cn-guangzhou\\\.personal\\\.cr\\\.aliyuncs\\\.com\/junjunorder\/junjunorder/, "deploy job whitelists the ACR repository");
  assert.match(workflow, /ghcr\.io\/jjgitt\/junjunorder/);
  assert.match(rollback, /"\$DEPLOY_USER@\$DEPLOY_HOST" "ghcr\.io\/jjgitt\/junjunorder@\$IMAGE_DIGEST"/);
  assert.doesNotMatch(workflow, /SWR_PASSWORD:\s*['"]?[A-Za-z0-9+/=]{20,}/);
  assert.doesNotMatch(workflow, /ACR_PASSWORD:\s*['"]?[A-Za-z0-9+/=]{20,}/);
});
