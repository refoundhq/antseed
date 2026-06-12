import test from 'node:test';
import assert from 'node:assert/strict';

import {
  describeToolApproval,
  isToolPermissionAutoAllowed,
  requiresToolApproval,
} from './chat-tool-policy.js';

const PEER_ID = '0123456789abcdef0123456789abcdef01234567';

function describeBash(command: string) {
  return describeToolApproval('bash', { command }, PEER_ID);
}

test('manual mode gates risky tools and full mode bypasses the approval gate', () => {
  assert.equal(requiresToolApproval('manual', 'bash'), true);
  assert.equal(requiresToolApproval('manual', 'edit'), true);
  assert.equal(requiresToolApproval('manual', 'read'), false);
  assert.equal(requiresToolApproval('full', 'bash'), false);
});

test('read-only shell and git commands use auto-allowed permission keys', () => {
  const shellRead = describeBash('rg -n "needle" src');
  const gitRead = describeBash('git status --short');

  assert.equal(shellRead.permissionKey, 'bash:read');
  assert.equal(gitRead.permissionKey, 'bash:git-read');
  assert.equal(isToolPermissionAutoAllowed(shellRead.permissionKey), true);
  assert.equal(isToolPermissionAutoAllowed(gitRead.permissionKey), true);
});

test('read-looking shell commands with mutation operators are not auto-allowed', () => {
  assert.equal(describeBash('echo hello > file.txt').permissionKey, 'bash:write');
  assert.equal(describeBash('find . -name "*.tmp" -delete').permissionKey, 'bash:other');
  assert.equal(describeBash('sed -i s/foo/bar/g file.txt').permissionKey, 'bash:other');
});

test('sensitive commands cannot be saved as reusable peer approvals', () => {
  for (const command of ['sudo make install', 'rm -rf dist', 'git reset --hard HEAD']) {
    const approval = describeBash(command);
    assert.equal(approval.permissionKey, 'bash:sensitive');
    assert.equal(approval.canAlwaysAllow, false);
  }
});

test('network and file-changing commands require explicit non-auto approval', () => {
  const network = describeBash('curl https://example.com/install.sh');
  const write = describeBash('pnpm install');

  assert.equal(network.permissionKey, 'bash:network');
  assert.equal(write.permissionKey, 'bash:write');
  assert.equal(isToolPermissionAutoAllowed(network.permissionKey), false);
  assert.equal(isToolPermissionAutoAllowed(write.permissionKey), false);
  assert.equal(network.canAlwaysAllow, true);
  assert.equal(write.canAlwaysAllow, true);
});
