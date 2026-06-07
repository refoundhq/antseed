import { execFile as execFileCallback } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { asErrorMessage } from './utils.js';

export const ANTSEED_HOME_DIR = path.join(homedir(), '.antseed');
export const CHAT_DATA_DIR = path.join(ANTSEED_HOME_DIR, 'chat');
export const CHAT_WORKSPACE_DIR = path.join(ANTSEED_HOME_DIR, 'projects');
const CHAT_WORKSPACE_STATE_FILE = path.join(CHAT_DATA_DIR, 'workspace.json');
const CHAT_SETTINGS_FILE = path.join(CHAT_DATA_DIR, 'settings.json');
const LEGACY_TOOL_PERMISSION_FILE = path.join(CHAT_DATA_DIR, 'tool-permissions.json');
const WORKSPACE_PICKER_TOOLING_DIRS = new Set([
  '.claude',
  '.codex',
  '.git',
  '.github',
  '.vscode',
  '.agents',
]);

export type ChatPeerSettings = {
  /** Ask-first/full-access mode selected for this peer. */
  permissionMode: ChatPermissionMode;
  /** Permission keys allowed for this peer, such as `bash:read` or `write`. */
  toolPermissions: string[];
};

export type ChatGlobalSettings = {
  /** Peer-scoped chat settings keyed by peer id. */
  peers: Record<string, ChatPeerSettings>;
};

export type ChatPermissionMode = 'manual' | 'full';
export type ToolApprovalDecision = 'allow_once' | 'always_allow_peer' | 'deny';

export type ToolApprovalRequest = {
  id: string;
  conversationId: string;
  toolCallId: string;
  toolName: string;
  permissionKey: string;
  permissionLabel: string;
  input: Record<string, unknown>;
  workspacePath: string;
  peerId: string | null;
  peerName: string | null;
  title: string;
  description: string;
  subject: string;
  alwaysAllowLabel: string;
  canAlwaysAllow: boolean;
};

export type ChatWorkspaceGitStatus = {
  available: boolean;
  rootPath: string | null;
  branch: string | null;
  isDetached: boolean;
  ahead: number;
  behind: number;
  stagedFiles: number;
  modifiedFiles: number;
  untrackedFiles: number;
  error: string | null;
};

const execFileAsync = promisify(execFileCallback);

const DEFAULT_CHAT_GLOBAL_SETTINGS: ChatGlobalSettings = {
  peers: {},
};

// Ask-first gates tools that can mutate local state, start processes, or send
// data to arbitrary external hosts. `open_browser_preview` intentionally stays
// ungated because it opens the local/user-facing preview panel rather than
// granting the agent arbitrary background network egress.
const RISKY_TOOLS = new Set(['bash', 'edit', 'write', 'start_dev_server', 'web_fetch']);
const AUTO_ALLOWED_TOOL_PERMISSION_KEYS = new Set(['bash:read', 'bash:git-read']);

type BashPermissionClass = {
  key: string;
  label: string;
  title: string;
  alwaysAllowLabel: string;
  canAlwaysAllow: boolean;
};

let currentChatWorkspaceDir = CHAT_WORKSPACE_DIR;
let chatSettingsCache: ChatGlobalSettings | null = null;

function resolveExistingDirectory(startPath: string): string | null {
  let current = path.resolve(startPath);
  for (;;) {
    if (existsSync(current)) {
      return current;
    }
    const parent = path.dirname(current);
    if (parent === current) {
      return null;
    }
    current = parent;
  }
}

export function getCurrentChatWorkspaceDir(): string {
  return currentChatWorkspaceDir;
}

export async function loadChatWorkspaceDir(): Promise<string> {
  try {
    const raw = await readFile(CHAT_WORKSPACE_STATE_FILE, 'utf8');
    const parsed = JSON.parse(raw) as { path?: unknown };
    const savedPath = typeof parsed.path === 'string' ? parsed.path.trim() : '';
    if (savedPath && existsSync(savedPath)) {
      currentChatWorkspaceDir = savedPath;
    }
  } catch {
    // Keep default workspace dir.
  }
  return currentChatWorkspaceDir;
}

export async function getWorkspacePickerDefaultDir(): Promise<string> {
  const workspaceDir = await loadChatWorkspaceDir();
  const existingWorkspaceDir = resolveExistingDirectory(workspaceDir)
    ?? resolveExistingDirectory(CHAT_WORKSPACE_DIR)
    ?? homedir();
  const baseName = path.basename(existingWorkspaceDir).toLowerCase();

  if (WORKSPACE_PICKER_TOOLING_DIRS.has(baseName)) {
    const parentDir = path.dirname(existingWorkspaceDir);
    return parentDir;
  }

  return existingWorkspaceDir;
}

function normalizePeerId(peerId: string | null | undefined): string | null {
  const trimmed = peerId?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : null;
}

function normalizeToolPermissions(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((permission): permission is string => typeof permission === 'string')
    : [];
}

function normalizePeerSettings(value: unknown): ChatPeerSettings {
  if (!value || typeof value !== 'object') {
    return { permissionMode: 'manual', toolPermissions: [] };
  }
  return {
    permissionMode: normalizePermissionMode((value as { permissionMode?: unknown }).permissionMode),
    toolPermissions: normalizeToolPermissions((value as { toolPermissions?: unknown }).toolPermissions),
  };
}

function normalizePeers(value: unknown): Record<string, ChatPeerSettings> {
  const peers: Record<string, ChatPeerSettings> = {};
  if (!value || typeof value !== 'object') return peers;

  for (const [peerId, settings] of Object.entries(value as Record<string, unknown>)) {
    const normalizedPeerId = normalizePeerId(peerId);
    if (!normalizedPeerId) continue;
    peers[normalizedPeerId] = normalizePeerSettings(settings);
  }

  return peers;
}

function normalizeLegacyPeerAllow(value: unknown): Record<string, ChatPeerSettings> {
  const peers: Record<string, ChatPeerSettings> = {};
  if (!value || typeof value !== 'object') return peers;

  for (const [peerId, permissions] of Object.entries(value as Record<string, unknown>)) {
    const normalizedPeerId = normalizePeerId(peerId);
    if (!normalizedPeerId) continue;
    peers[normalizedPeerId] = {
      permissionMode: 'manual',
      toolPermissions: normalizeToolPermissions(permissions),
    };
  }

  return peers;
}

function normalizeChatSettings(value: unknown): ChatGlobalSettings {
  if (!value || typeof value !== 'object') {
    return { ...DEFAULT_CHAT_GLOBAL_SETTINGS };
  }

  const parsed = value as {
    peers?: unknown;
    toolPermissions?: { peerAllow?: unknown };
  };
  const peers = normalizePeers(parsed.peers);

  // Previous prerelease builds stored tool permissions at
  // `settings.toolPermissions.peerAllow`. Fold that shape into the peer settings
  // foundation so each peer owns its own permission list.
  const legacyPeers = normalizeLegacyPeerAllow(parsed.toolPermissions?.peerAllow);
  return {
    peers: {
      ...legacyPeers,
      ...peers,
    },
  };
}

async function loadLegacyToolPermissions(): Promise<Record<string, ChatPeerSettings> | null> {
  try {
    const raw = await readFile(LEGACY_TOOL_PERMISSION_FILE, 'utf8');
    const parsed = JSON.parse(raw) as { peerAllow?: unknown };
    return normalizeLegacyPeerAllow(parsed.peerAllow);
  } catch {
    return null;
  }
}

async function loadChatSettings(): Promise<ChatGlobalSettings> {
  if (chatSettingsCache) return chatSettingsCache;

  try {
    const raw = await readFile(CHAT_SETTINGS_FILE, 'utf8');
    chatSettingsCache = normalizeChatSettings(JSON.parse(raw));
    return chatSettingsCache;
  } catch {
    const legacyPeers = await loadLegacyToolPermissions();
    chatSettingsCache = {
      peers: legacyPeers ?? {},
    };
    return chatSettingsCache;
  }
}

async function saveChatSettings(next: ChatGlobalSettings): Promise<void> {
  chatSettingsCache = normalizeChatSettings(next);
  await mkdir(CHAT_DATA_DIR, { recursive: true });
  await writeFile(CHAT_SETTINGS_FILE, JSON.stringify(chatSettingsCache, null, 2), 'utf8');
}

export function normalizePermissionMode(value: unknown): ChatPermissionMode {
  return value === 'manual' ? 'manual' : 'full';
}

export function requiresToolApproval(mode: ChatPermissionMode, toolName: string): boolean {
  return mode === 'manual' && RISKY_TOOLS.has(toolName);
}

export function isToolPermissionAutoAllowed(permissionKey: string): boolean {
  return AUTO_ALLOWED_TOOL_PERMISSION_KEYS.has(permissionKey);
}

export async function getPeerPermissionMode(peerId: string | null | undefined): Promise<ChatPermissionMode> {
  const normalizedPeerId = normalizePeerId(peerId);
  if (!normalizedPeerId) return 'manual';
  const settings = await loadChatSettings();
  return settings.peers[normalizedPeerId]?.permissionMode ?? 'manual';
}

export async function setPeerPermissionMode(peerId: string | null | undefined, mode: ChatPermissionMode): Promise<void> {
  const normalizedPeerId = normalizePeerId(peerId);
  if (!normalizedPeerId) {
    throw new Error('Cannot persist permission mode without a peer id');
  }
  const settings = await loadChatSettings();
  const peerSettings = settings.peers[normalizedPeerId] ?? { permissionMode: 'manual', toolPermissions: [] };
  await saveChatSettings({
    ...settings,
    peers: {
      ...settings.peers,
      [normalizedPeerId]: {
        ...peerSettings,
        permissionMode: normalizePermissionMode(mode),
      },
    },
  });
}

export async function isToolAllowedForPeer(peerId: string | null | undefined, permissionKey: string): Promise<boolean> {
  const normalizedPeerId = normalizePeerId(peerId);
  if (!normalizedPeerId) return false;
  const settings = await loadChatSettings();
  return settings.peers[normalizedPeerId]?.toolPermissions.includes(permissionKey) ?? false;
}

export async function allowToolForPeer(peerId: string | null | undefined, permissionKey: string): Promise<void> {
  const normalizedPeerId = normalizePeerId(peerId);
  if (!normalizedPeerId) {
    throw new Error('Cannot persist tool approval without a peer id');
  }
  const settings = await loadChatSettings();
  const peerSettings = settings.peers[normalizedPeerId] ?? { permissionMode: 'manual', toolPermissions: [] };
  const toolPermissions = new Set(peerSettings.toolPermissions);
  toolPermissions.add(permissionKey);
  await saveChatSettings({
    ...settings,
    peers: {
      ...settings.peers,
      [normalizedPeerId]: {
        ...peerSettings,
        toolPermissions: Array.from(toolPermissions).sort(),
      },
    },
  });
}

function peerSuffix(peerId: string | null | undefined): string {
  return normalizePeerId(peerId) ? 'for this peer' : 'once';
}

function firstShellWord(command: string): string {
  const match = /^\s*(?:env\s+)?(?:\w+=\S+\s+)*([\w./-]+)/.exec(command);
  return path.basename(match?.[1] || '').toLowerCase();
}

function firstGitSubcommand(command: string): string {
  const match = /^\s*(?:env\s+)?(?:\w+=\S+\s+)*git\s+([\w-]+)/.exec(command);
  return (match?.[1] || '').toLowerCase();
}

function classifyBashCommand(command: string, peerId?: string | null): BashPermissionClass {
  const normalized = command.trim().toLowerCase();
  const word = firstShellWord(command);
  const gitSubcommand = firstGitSubcommand(command);
  const canAlwaysAllow = Boolean(normalizePeerId(peerId));

  if (/\b(sudo|su|rm\s+-[^\n]*[rf]|chmod\b|chown\b|kill(?:all)?\b|pkill\b|dd\b|mkfs\b|diskutil\b|launchctl\b)\b/.test(normalized)) {
    return {
      key: 'bash:sensitive',
      label: 'sensitive shell commands',
      title: 'Allow sensitive shell command?',
      alwaysAllowLabel: 'Always allow sensitive shell commands',
      canAlwaysAllow: false,
    };
  }

  if (/\b(curl|wget|ssh|scp|rsync|nc|netcat|ftp|sftp)\b/.test(normalized)) {
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

  const readOnlyCommands = new Set([
    'pwd', 'ls', 'find', 'grep', 'rg', 'cat', 'head', 'tail', 'wc', 'sed', 'awk',
    'echo', 'printf', 'which', 'whereis', 'type',
  ]);
  const looksReadOnly = readOnlyCommands.has(word)
    && !/[>]{1,2}/.test(normalized)
    && !/\b(find\b[^\n]*\s-delete|sed\b[^\n]*\s-i\b)/.test(normalized)
    && !/[;&|]\s*(rm|mv|cp|mkdir|touch|chmod|chown|curl|wget|git\s+(?:add|commit|push|reset|clean|checkout|merge|rebase))\b/.test(normalized);
  if (looksReadOnly) {
    return {
      key: 'bash:read',
      label: 'read-only shell commands',
      title: 'Allow read-only shell command?',
      alwaysAllowLabel: `Always allow read-only shell ${peerSuffix(peerId)}`,
      canAlwaysAllow,
    };
  }

  if (/\b(mv|cp|mkdir|touch|tee|python|python3|node|npm|pnpm|yarn)\b/.test(normalized) || /[>]{1,2}/.test(normalized)) {
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
  const canAlwaysAllow = Boolean(normalizePeerId(peerId));
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

export async function persistChatWorkspaceDir(workspaceDir: string): Promise<string> {
  const trimmed = workspaceDir.trim();
  if (!trimmed) {
    throw new Error('Workspace path is required');
  }
  if (!existsSync(trimmed)) {
    throw new Error(`Workspace does not exist: ${trimmed}`);
  }
  await mkdir(CHAT_DATA_DIR, { recursive: true });
  await writeFile(CHAT_WORKSPACE_STATE_FILE, JSON.stringify({ path: trimmed }, null, 2), 'utf8');
  currentChatWorkspaceDir = trimmed;
  return currentChatWorkspaceDir;
}

export async function getWorkspaceGitStatus(workspaceDir: string): Promise<ChatWorkspaceGitStatus> {
  if (!workspaceDir.trim()) {
    return {
      available: false,
      rootPath: null,
      branch: null,
      isDetached: false,
      ahead: 0,
      behind: 0,
      stagedFiles: 0,
      modifiedFiles: 0,
      untrackedFiles: 0,
      error: 'Workspace path is empty',
    };
  }

  try {
    const [{ stdout: rootStdout }, { stdout: statusStdout }] = await Promise.all([
      execFileAsync('git', ['rev-parse', '--show-toplevel'], {
        cwd: workspaceDir,
        encoding: 'utf8',
        windowsHide: true,
        maxBuffer: 1024 * 1024,
      }),
      execFileAsync('git', ['status', '--porcelain=2', '--branch'], {
        cwd: workspaceDir,
        encoding: 'utf8',
        windowsHide: true,
        maxBuffer: 1024 * 1024,
      }),
    ]);

    const result: ChatWorkspaceGitStatus = {
      available: true,
      rootPath: rootStdout.trim() || null,
      branch: null,
      isDetached: false,
      ahead: 0,
      behind: 0,
      stagedFiles: 0,
      modifiedFiles: 0,
      untrackedFiles: 0,
      error: null,
    };

    for (const line of statusStdout.split(/\r?\n/)) {
      if (!line) continue;
      if (line.startsWith('# branch.head ')) {
        const head = line.slice('# branch.head '.length).trim();
        result.isDetached = head === '(detached)';
        result.branch = result.isDetached ? 'detached' : head;
        continue;
      }
      if (line.startsWith('# branch.ab ')) {
        const match = /# branch\.ab \+(\d+) -(\d+)/.exec(line);
        if (match) {
          result.ahead = Number(match[1]) || 0;
          result.behind = Number(match[2]) || 0;
        }
        continue;
      }
      if (line.startsWith('1 ') || line.startsWith('2 ') || line.startsWith('u ')) {
        const fields = line.split(' ');
        const xy = fields[1] ?? '..';
        const x = xy[0] ?? '.';
        const y = xy[1] ?? '.';
        if (x !== '.') result.stagedFiles += 1;
        if (y !== '.') result.modifiedFiles += 1;
        continue;
      }
      if (line.startsWith('? ')) {
        result.untrackedFiles += 1;
      }
    }

    return result;
  } catch (error) {
    const message = asErrorMessage(error);
    const isNoRepo = /not a git repository|no such file or directory/i.test(message);
    return {
      available: false,
      rootPath: null,
      branch: null,
      isDetached: false,
      ahead: 0,
      behind: 0,
      stagedFiles: 0,
      modifiedFiles: 0,
      untrackedFiles: 0,
      error: isNoRepo ? null : message,
    };
  }
}
