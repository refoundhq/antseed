import path from 'node:path';
import type { ChatPermissionMode, ToolApprovalRequest } from './chat-permissions.js';

const RISKY_TOOLS = new Set(['bash', 'edit', 'write', 'start_dev_server', 'web_fetch']);
const AUTO_ALLOWED_TOOL_PERMISSION_KEYS = new Set(['bash:read', 'bash:git-read']);

type BashPermissionClass = {
  key: string;
  label: string;
  title: string;
  alwaysAllowLabel: string;
  canAlwaysAllow: boolean;
};

export function requiresToolApproval(mode: ChatPermissionMode, toolName: string): boolean {
  return mode === 'manual' && RISKY_TOOLS.has(toolName);
}

export function isToolPermissionAutoAllowed(permissionKey: string): boolean {
  return AUTO_ALLOWED_TOOL_PERMISSION_KEYS.has(permissionKey);
}

function hasPeer(peerId: string | null | undefined): boolean {
  return Boolean(peerId?.trim());
}

function peerSuffix(peerId: string | null | undefined): string {
  return hasPeer(peerId) ? 'for this peer' : 'once';
}

function firstShellWord(command: string): string {
  const match = /^\s*(?:env\s+)?(?:\w+=\S+\s+)*([\w./-]+)/.exec(command);
  return path.basename(match?.[1] || '').toLowerCase();
}

function firstGitSubcommand(command: string): string {
  const match = /^\s*(?:env\s+)?(?:\w+=\S+\s+)*git\s+([\w-]+)/.exec(command);
  return (match?.[1] || '').toLowerCase();
}

function hasShellWriteOperator(command: string): boolean {
  return /(^|[^<>])>{1,2}([^>]|$)|\btee\b/.test(command);
}

function isSensitiveShellCommand(command: string): boolean {
  return [
    /\bsudo\b/,
    /\bsu(?:do)?\s+-/,
    /\brm\s+(?:-[^\n\s]*[rf][^\n\s]*\s+){1,}/,
    /\b(?:chmod|chown|chgrp|kill|killall|pkill|dd|mkfs|mount|umount|diskutil|launchctl|crontab)\b/,
    /\bgit\s+(?:reset\s+--hard|clean\s+-[^\n\s]*f|push\s+--force(?:-with-lease)?|checkout\s+-f)\b/,
    /\b(?:security|codesign|spctl|xattr)\b/,
  ].some((pattern) => pattern.test(command));
}

function isNetworkShellCommand(command: string): boolean {
  return /\b(?:curl|wget|ssh|scp|rsync|nc|netcat|telnet|ftp|sftp)\b/.test(command);
}

function isReadOnlyShellCommand(command: string, word: string): boolean {
  const readOnlyCommands = new Set([
    'pwd', 'ls', 'find', 'grep', 'rg', 'cat', 'head', 'tail', 'wc', 'sed', 'awk',
    'echo', 'printf', 'which', 'whereis', 'type',
  ]);
  return readOnlyCommands.has(word)
    && !hasShellWriteOperator(command)
    && !/\bfind\b[^\n]*(?:\s-delete|\s-exec\s+(?:rm|mv|cp|chmod|chown|sh|bash)\b)/.test(command)
    && !/\bsed\b[^\n]*\s-i(?:\s|$)/.test(command)
    && !/[;&|]\s*(?:rm|mv|cp|mkdir|touch|chmod|chown|curl|wget|git\s+(?:add|commit|push|reset|clean|checkout|merge|rebase))\b/.test(command);
}

function isFileChangingShellCommand(command: string): boolean {
  return hasShellWriteOperator(command)
    || /\b(?:mv|cp|mkdir|touch|install|ln|python|python3|node|npm|pnpm|yarn|bun)\b/.test(command);
}

function classifyBashCommand(command: string, peerId?: string | null): BashPermissionClass {
  const normalized = command.trim().toLowerCase();
  const word = firstShellWord(command);
  const gitSubcommand = firstGitSubcommand(command);
  const canAlwaysAllow = hasPeer(peerId);

  if (isSensitiveShellCommand(normalized)) {
    return {
      key: 'bash:sensitive',
      label: 'sensitive shell commands',
      title: 'Allow sensitive shell command?',
      alwaysAllowLabel: 'Always allow sensitive shell commands',
      canAlwaysAllow: false,
    };
  }

  if (isNetworkShellCommand(normalized)) {
    return {
      key: 'bash:network',
      label: 'network shell commands',
      title: 'Allow network shell command?',
      alwaysAllowLabel: `Always allow network commands ${peerSuffix(peerId)}`,
      canAlwaysAllow,
    };
  }

  if (word === 'git') {
    const readOnlyGit = new Set(['status', 'diff', 'log', 'show', 'branch', 'rev-parse', 'ls-files', 'remote', 'config']);
    if (readOnlyGit.has(gitSubcommand)) {
      return {
        key: 'bash:git-read',
        label: 'read-only git commands',
        title: 'Allow read-only git command?',
        alwaysAllowLabel: `Always allow read-only git ${peerSuffix(peerId)}`,
        canAlwaysAllow,
      };
    }
    return {
      key: 'bash:git-write',
      label: 'git change commands',
      title: 'Allow git change command?',
      alwaysAllowLabel: `Always allow git changes ${peerSuffix(peerId)}`,
      canAlwaysAllow,
    };
  }

  if (isReadOnlyShellCommand(normalized, word)) {
    return {
      key: 'bash:read',
      label: 'read-only shell commands',
      title: 'Allow read-only shell command?',
      alwaysAllowLabel: `Always allow read-only shell ${peerSuffix(peerId)}`,
      canAlwaysAllow,
    };
  }

  if (isFileChangingShellCommand(normalized)) {
    return {
      key: 'bash:write',
      label: 'shell commands that can change files',
      title: 'Allow file-changing shell command?',
      alwaysAllowLabel: `Always allow file-changing shell ${peerSuffix(peerId)}`,
      canAlwaysAllow,
    };
  }

  return {
    key: 'bash:other',
    label: 'other shell commands',
    title: 'Allow shell command?',
    alwaysAllowLabel: `Always allow shell commands ${peerSuffix(peerId)}`,
    canAlwaysAllow: false,
  };
}

export function describeToolApproval(toolName: string, input: Record<string, unknown>, peerId?: string | null): Pick<ToolApprovalRequest, 'permissionKey' | 'permissionLabel' | 'title' | 'description' | 'subject' | 'alwaysAllowLabel' | 'canAlwaysAllow'> {
  const canAlwaysAllow = hasPeer(peerId);
  if (toolName === 'bash') {
    const command = typeof input.command === 'string' ? input.command : JSON.stringify(input, null, 2);
    const bashClass = classifyBashCommand(command, peerId);
    return {
      permissionKey: bashClass.key,
      permissionLabel: bashClass.label,
      title: bashClass.title,
      description: '',
      subject: command,
      alwaysAllowLabel: bashClass.alwaysAllowLabel,
      canAlwaysAllow: bashClass.canAlwaysAllow,
    };
  }
  if (toolName === 'edit') {
    return {
      permissionKey: 'edit',
      permissionLabel: 'file edits',
      title: 'Allow file edit?',
      description: '',
      subject: typeof input.path === 'string' ? input.path : JSON.stringify(input, null, 2),
      alwaysAllowLabel: `Always allow file edits ${peerSuffix(peerId)}`,
      canAlwaysAllow,
    };
  }
  if (toolName === 'write') {
    return {
      permissionKey: 'write',
      permissionLabel: 'file writes',
      title: 'Allow file write?',
      description: '',
      subject: typeof input.path === 'string' ? input.path : JSON.stringify(input, null, 2),
      alwaysAllowLabel: `Always allow file writes ${peerSuffix(peerId)}`,
      canAlwaysAllow,
    };
  }
  if (toolName === 'start_dev_server') {
    return {
      permissionKey: 'start_dev_server',
      permissionLabel: 'dev server starts',
      title: 'Allow dev server?',
      description: '',
      subject: typeof input.command === 'string' ? input.command : JSON.stringify(input, null, 2),
      alwaysAllowLabel: `Always allow dev servers ${peerSuffix(peerId)}`,
      canAlwaysAllow,
    };
  }
  if (toolName === 'web_fetch') {
    const url = typeof input.url === 'string' ? input.url : typeof input.URL === 'string' ? input.URL : '';
    return {
      permissionKey: 'web_fetch',
      permissionLabel: 'web fetches',
      title: 'Allow web fetch?',
      description: '',
      subject: url || JSON.stringify(input, null, 2),
      alwaysAllowLabel: `Always allow web fetches ${peerSuffix(peerId)}`,
      canAlwaysAllow,
    };
  }
  return {
    permissionKey: toolName,
    permissionLabel: toolName,
    title: `Allow ${toolName}?`,
    description: `The agent wants to run ${toolName}.`,
    subject: JSON.stringify(input, null, 2),
    alwaysAllowLabel: `Always allow ${toolName} ${peerSuffix(peerId)}`,
    canAlwaysAllow,
  };
}
