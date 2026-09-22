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
    /timeout --signal=TERM --kill-after="\$\{pull_kill_after_seconds\}s" "\$\{timeout_seconds\}s" docker pull "\$ref"/,
  );
  assert.match(deploy, /Image pull failed; running service unchanged/);
  assert.match(deploy, /junjunorder:main#\[0-9a-f\]\{40\}/);
  assert.match(deploy, /Waiting for ACR build of \$sha on \$tag/);
  assert.match(deploy, /\/app\/source-revision/);
  assert.doesNotMatch(deploy, /from-seed/);
  assert.doesNotMatch(deploy, /seed_repository/);
});

test("workflow deploys the Aliyun China build and does not push from GitHub", async () => {
  const workflow = await readFile(new URL("../.github/workflows/ci-cd.yml", import.meta.url), "utf8");
  const dockerfile = await readFile(new URL("../Dockerfile", import.meta.url), "utf8");
  const rollback = await readFile(new URL("../deploy/ci/rollback/ghcr-20260915/ci-cd.yml", import.meta.url), "utf8");
  assert.match(dockerfile, /git rev-parse HEAD > \/source-revision/);
  assert.match(dockerfile, /COPY --from=revision --chown=nextjs:nodejs \/source-revision \.\/source-revision/);
  assert.doesNotMatch(workflow, /Push image to GHCR/);
  assert.doesNotMatch(workflow, /docker\/build-push-action/);
  assert.doesNotMatch(workflow, /Login to Huawei SWR/);
  assert.doesNotMatch(workflow, /Push image to Aliyun ACR/);
  assert.doesNotMatch(workflow, /imagetools create/);
  assert.match(workflow, /needs: test/);
  assert.match(workflow, /junjunorder:main#\$\{\{ github\.sha \}\}/);
  assert.match(workflow, /secrets\.ACR_USERNAME/);
  assert.match(workflow, /secrets\.ACR_PASSWORD/);
  assert.match(workflow, /\/app\/source-revision matches this commit/);
  assert.doesNotMatch(workflow, /SEED_REPOSITORY/);
  assert.doesNotMatch(workflow, /secrets\.SWR_USERNAME|secrets\.SWR_PASSWORD/);
  assert.match(rollback, /"\$DEPLOY_USER@\$DEPLOY_HOST" "ghcr\.io\/jjgitt\/junjunorder@\$IMAGE_DIGEST"/);
  assert.doesNotMatch(workflow, /SWR_PASSWORD:\s*['"]?[A-Za-z0-9+/=]{20,}/);
  assert.doesNotMatch(workflow, /ACR_PASSWORD:\s*['"]?[A-Za-z0-9+/=]{20,}/);
});
