"use client";
/* eslint-disable @next/next/no-img-element */
import { DailyWorkPicker } from "@/app/daily-work-picker";
import { SlackMemberConnections } from "@/app/slack-member-connections";
import type { DailyWork } from "@/lib/daily-work";
import { dailyRevisionChanged } from "@/lib/daily-revision";
import { PropertyValueInput } from "@/app/property-value-input";
import { DocumentProperties, type DocumentProperty } from "@/app/document-properties";
import { dailyDeliveryHealth, dailyDeliveryLabel } from "@/lib/slack-daily-status";
import {
  slackErrorMessage as baseSlackErrorMessage,
  slackReminderLabel as baseSlackReminderLabel,
} from "@/lib/slack-display";

import {
  Activity,
  Archive,
  ArrowLeft,
  ArrowDownUp,
  AtSign,
  Bot,
  BookTemplate,
  Briefcase,
  CalendarCheck,
  CalendarDays,
  ChartGantt,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  CircleHelp,
  Columns3,
  Copy,
  CreditCard,
  Database,
  Eye,
  EyeOff,
  Filter,
  Hash,
  House,
  ImageIcon,
  Inbox,
  Lightbulb,
  Link2,
  ListChecks,
  Languages,
  LockKeyhole,
  LoaderCircle,
  LogOut,
  Menu,
  MoreHorizontal,
  Pencil,
  Plus,
  Plug,
  Repeat2,
  RefreshCw,
  RotateCcw,
  Search,
  Send,
  Settings,
  Settings2,
  Sparkles,
  Table2,
  Target,
  TextCursorInput,
  Trash2,
  Upload,
  AlertTriangle,
  UserPlus,
  Users,
  X,
  Zap,
  type LucideIcon,
} from "lucide-react";
import { startTransition, useCallback, useEffect, useId, useMemo, useRef, useState, type ComponentType, type CSSProperties, type FormEvent, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from "react";
import { ConfirmationProvider, OverlayDialog, useAppConfirm } from "./overlay-dialog";
import AIConnectionsDialog from "./ai-connections";
import WorkspaceBackups from "./workspace-backups";
import WorkspaceIdentity from "./workspace-identity";
import { MarketingConsentPrompt, MarketingConsentSettings } from "./marketing-consent";
import { FirstRunSetup } from "./first-run-setup";
import { canAutoOpenSetup, type OnboardingState } from "@/lib/onboarding";
import { OkrFileSurface, type OkrFileCycleSummary } from "./okr-file-surface";
import BillingView from "./billing-view";
import GanttView from "./gantt-view";
import { ChatAiUsage } from "./ai-usage-meter";
import { aiUsageLimitMessage } from "@/lib/ai-usage";
import { invalidateAiUsage, type AiUsageScope } from "@/lib/ai-usage-client";
import { parseAssistantCommand } from "@/lib/assistant-command";
import { readMyWorkSort, saveMyWorkSort, sortMyWorkItems, type MyWorkSort } from "@/lib/my-work-sort";
import { DEFAULT_THEME, THEME_STORAGE_KEY, isThemeMode, themeColorScheme, type ThemeMode } from "@/lib/themes";
import { ThemePicker } from "./theme-picker";
import LanguageSettings from "./language-settings";
import { systemPropertyLabel } from "@/lib/property-label";
import { loadLanguage, translateForLanguage , messageValue } from "@/lib/client-language";
import { applyAccountLanguage, applyGuestLanguage, clearAccountLanguage, displayLanguageHeaders, displayDate, saveAccountLanguage, t, useLanguage, apiError , getClientLocale } from "@/lib/client-language";
import { languages, type Language } from "@/lib/language";
import LanguageLoadError from "./language-load-error";
import type { LanguagePreferences } from "@/lib/language";
import { LandingScreen } from "./landing";
import { AppInstallButton } from "./app-install-button";
import { BrandLogo } from "./brand-logo";
import { LocalAgentLauncher } from "./local-agent-launcher";
import { GuideDraft } from "./guide-draft";
import WorkspaceSearch, { type SearchDestination } from "./workspace-search";
import type { SearchResult } from "@/lib/workspace-search";

function slackErrorMessage(error: unknown, fallback?: string) {
  return t(baseSlackErrorMessage(error, fallback));
}

function slackReminderLabel(status: string) {
  return t(baseSlackReminderLabel(status));
}

function localizedWeekdayLabel(day: number) {
  return new Intl.DateTimeFormat(getClientLocale(), { weekday: "short", timeZone: "UTC" })
    .format(new Date(Date.UTC(2026, 7, 2 + day)));
}

type View = "home" | "my_work" | "inbox" | "work" | "gantt" | "routines" | "okr" | "data" | "scrum" | "recommendations" | "reviews" | "trash" | "integrations" | "billing";
const urlViews = new Set<View>(["my_work", "inbox", "work", "gantt", "routines", "okr", "data", "scrum", "recommendations", "reviews", "trash", "integrations", "billing"]);
type NoticeTone = "success" | "error" | "info";
type AppNotice = { id: number; message: string; tone: NoticeTone };

function navigationFromLocation() {
  if (typeof window === "undefined") return { view: "okr" as View, projectId: null as string | null, taskId: null as string | null };
  const params = new URLSearchParams(window.location.search);
  const rawView = params.get("view");
  const requestedView = (rawView === "kr_data" ? "data" : rawView) as View | null;
  const projectId = params.get("project");
  return {
    view: projectId ? "work" : requestedView && urlViews.has(requestedView) ? requestedView : params.get("guide") === "1" ? "home" : "okr",
    projectId,
    taskId: projectId ? null : params.get("task"),
  };
}

function workspaceSettingsFromLocation() {
  if (typeof window === "undefined") return { open: false, tab: "general" as WorkspaceSettingsTab };
  const params = new URLSearchParams(window.location.search);
  const rawTab = params.get("tab") as WorkspaceSettingsTab | "management" | null;
  const normalizedTab = rawTab === "management" ? "summary" : rawTab;
  const supported = new Set<WorkspaceSettingsTab>(["general", "members", "groups", "projects", "summary", "integrations", "backups", "danger", "scheduled"]);
  return {
    open: params.get("settings") === "workspace",
    tab: normalizedTab && supported.has(normalizedTab) ? normalizedTab : "general",
  };
}
type Cadence = "daily" | "weekly" | "monthly" | "quarterly";
type ItemStatus = "backlog" | "todo" | "policy_discussion" | "in_progress" | "developing" | "development_done" | "done" | "blocked" | "archived";
type ItemKind = "objective" | "key_result" | "initiative" | "project" | "task";
type Priority = "low" | "medium" | "high" | "urgent";
type PropertyType = "text" | "number" | "select" | "date" | "checkbox" | "member" | "members";
type PropertyValue = string | number | boolean | string[] | null;
type RoutineCadence = "daily" | "weekly" | "monthly";
type TeamRole = "owner" | "admin" | "member" | "viewer";
type GroupColor = "gray" | "blue" | "green" | "yellow" | "orange" | "red" | "purple";
type GroupVisibility = "open" | "private";
type GroupRole = "lead" | "member";
type WorkspaceSettingsTab = "general" | "members" | "groups" | "projects" | "summary" | "integrations" | "backups" | "danger" | "scheduled";
type ItemAssignmentRole = "project_dri" | "project_worker" | "task_assignee";
type AuthUser = { id: string; email: string | null; displayName: string; provider: "google" | "local"; preferences?: LanguagePreferences; onboarding?: OnboardingState | null };
type AuthState = { status: "loading" | "authenticated" | "unauthenticated"; user: AuthUser | null; reason: string | null };


type ItemAssignment = {
  id: string;
  memberId: string;
  displayName: string;
  email: string;
  role: ItemAssignmentRole;
};

type OkriItem = {
  id: string;
  cycleId: string | null;
  parentId: string | null;
  routineId: string | null;
  kind: ItemKind;
  title: string;
  description: string;
  status: ItemStatus;
  priority: Priority;
  cadence: Cadence;
  progress: number;
  dueDate: string | null;
  source: string;
  createdByUserId: string | null;
  archivedAt: string | null;
  archivedFromStatus: ItemStatus | null;
  archiveRootId: string | null;
  assignments: ItemAssignment[];
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
};

type OkrCycle = {
  id: string;
  name: string;
  department: string;
  version: number;
  startDate: string;
  endDate: string;
  status: "planned" | "active" | "closed";
  createdAt: string;
  updatedAt: string;
};

type DataViewProps = {
  cacheKey: string;
  items: Pick<OkriItem, "id" | "kind" | "cycleId" | "parentId" | "title" | "progress">[];
  cycles: Pick<OkrCycle, "id" | "name">[];
  readOnly: boolean;
  onProgressChange: (id: string, progress: number) => void;
  onNotice: (message: string) => void;
};

type PropertyDefinition = {
  id: string;
  name: string;
  type: PropertyType;
  options: string[];
  defaultValue: PropertyValue;
  systemKey: string | null;
  active: boolean;
  sortOrder: number;
  valueCount: number;
};

type ProjectDocument = { id: string | null; projectId: string; content: string; plainText: string; version: number; updatedAt: string };
type WorkDocument = { id: string | null; targetKind: "task" | "routine"; targetId: string; content: string; plainText: string; version: number; updatedAt: string };
type ProjectTemplate = { id: string; name: string; description: string; content: string; plainText: string; createdAt: string; updatedAt: string };
type ProjectBlockEditorChange = { content: string; plainText: string };
type ProjectDataConnection = {
  id: string;
  itemId: string;
  targetKind: "project";
  name: string;
  valuePath: string;
  baselineValue: number;
  targetValue: number;
  unit: string;
  cadence: "hourly" | "daily" | "weekly" | "manual";
  active: boolean;
  lastValue: number | null;
  lastSyncStatus: "never" | "success" | "error";
  lastError: string;
  lastSyncedAt: string | null;
};

type PropertyValueMap = Record<string, Record<string, PropertyValue>>;
type ProjectHiddenPropertyMap = Record<string, string[]>;
type ArchivedProject = OkriItem & { archivedTaskCount: number };
type TrashedItem = OkriItem & { trashedTaskCount: number; canDelete: boolean; restoreParentRequired: boolean };
type TrashInitiativeOption = { id: string; title: string; cycleId: string };
type ChecklistItem = { id: string; taskId: string; title: string; completed: boolean; sortOrder: number };
type DailySkipReason = "workload" | "vacation" | "personal" | "other";
type DailyTaskCandidate = { id: string; title: string; status: ItemStatus; dueDate: string | null; parentKind: "project" | "routine" | "general"; parentId: string | null; parentTitle: string };
type DailySubmission = { work?: DailyWork[]; yesterdayWork?: DailyWork[]; newlyCompletedCount?: number; id: string; memberId: string | null; memberName: string; memberEmail: string; date: string; version: number; yesterdayNote: string; todayNote: string; blockersNote: string; noPlannedTasks: boolean; skipReason: DailySkipReason | null; skipNote: string; source: string; submittedAt: string; tasks: Array<{ id: string; taskId: string | null; taskTitle: string; parentKind: string; parentId: string | null; parentTitle: string; status: string; isNew: boolean; sortOrder: number }> };
type DailyDashboard = {
  date: string;
  member: { id: string; displayName: string; email: string; role: TeamRole };
  draft: { id: string | null; date: string; yesterdayNote: string; todayNote: string; blockersNote: string; noPlannedTasks: boolean; skipReason: DailySkipReason | null; skipNote: string; selectedTaskIds: string[]; selectedWorkIds?: string[]; selectedYesterdayWorkIds?: string[]; source: string; updatedAt: string | null };
  latestSubmission: DailySubmission | null;
  candidates: { work?: DailyWork[]; yesterdayWork?: DailyWork[]; tasks: DailyTaskCandidate[]; groups: Array<{ key: string; kind: string; id: string | null; title: string; tasks: DailyTaskCandidate[] }> };
  createTargets: { projects: Array<{ id: string; title: string; needsTask: boolean; hasTasks?: boolean }>; routines: Array<{ id: string; title: string; needsTask?: boolean; hasTasks?: boolean }>; allowGeneral: boolean };
  team: Array<{ memberId: string; displayName: string; email: string; role: TeamRole; status: "submitted" | "skipped" | "writing" | "missing"; slackConnected: boolean; submission: DailySubmission | null }>;
  legacyWorkspaceNote: { yesterdayNote: string; todayNote: string; blockersNote: string; updatedAt: string } | null;
};
type Recommendation = {
  id: string;
  kind: "blocked" | "overdue" | "due_soon" | "empty_project";
  title: string;
  detail: string;
  itemIds: string[];
  score: number;
};
type Routine = {
  id: string;
  title: string;
  description: string;
  triggerPoint: string;
  actionPlace: string;
  actionSteps: string;
  properties?: Record<string, PropertyValue>;
  cadence: RoutineCadence;
  active: boolean;
  sortOrder: number;
  systemKey: string | null;
  assigneeMemberId: string | null;
  date: string;
  completed: boolean;
  completionId: string | null;
  note: string;
};

type WorkspaceRules = {
  workspaceId: string;
  captureInstruction: string;
  structureInstruction: string;
  routineInstruction: string;
  defaultPriority: Priority;
  defaultCadence: Cadence;
  reviewBeforeCreate: boolean;
  configured: boolean;
  updatedAt: string;
};

type DraftInitiative = {
  clientId: string;
  title: string;
};

type DraftKeyResult = {
  clientId: string;
  title: string;
  initiatives: DraftInitiative[];
};

type OnboardingPlan = {
  objectiveTitle: string;
  keyResults: DraftKeyResult[];
  targetInitiatives: DraftInitiative[];
  unassignedInitiatives: DraftInitiative[];
  project: string;
  tasks: string;
  taskParent: "" | "project" | "routine";
  routineTitle: string;
  routineTrigger: string;
  routinePlace: string;
  routineSteps: string;
  routineCadence: RoutineCadence;
};

type StringPlanField = "project" | "tasks" | "taskParent" | "routineTitle" | "routineTrigger" | "routinePlace" | "routineSteps";

type OkrChatContext = {
  key: string;
  entry: "onboarding" | "coach" | "create" | "project" | "routine" | "task";
  cycleId: string;
  cycleName: string;
  initialMessage: string;
  sourceKind?: ItemKind;
  target?: OkrPlanTarget | null;
  targetCandidates?: OkrPlanTarget[];
};

type OkrPlanTarget = {
  id: string;
  kind: "objective" | "key_result" | "initiative" | "project";
  title: string;
};

type AssistantWorkspaceContext = {
  cycleId: string | null;
  cycleName: string;
  focusedItemId: string | null;
  blockedTaskCount: number;
  items: Array<{
    id: string;
    parentId: string | null;
    kind: ItemKind;
    title: string;
    status: ItemStatus;
    progress: number;
    dri: string;
  }>;
};

type OrganizedOkr = {
  assistantMessage: string;
  questions: string[];
  plan: OnboardingPlan;
};

type PlanCreationResult = {
  cycleId: string | null;
  items: OkriItem[];
  keyResultIds: string[];
  initiativeIds: string[];
  projectIds: string[];
};

type ProjectChatTarget = {
  cycleId: string | null;
  cycleName: string;
  initiativeId: string;
  initiativeTitle: string;
};

type TaskContainerOption = {
  id: string;
  kind: "project" | "routine";
  title: string;
};

type OkrPlanApplyResult = {
  items: OkriItem[];
  cycleId: string;
  objectiveId: string | null;
  keyResultIds: string[];
  initiativeIds: string[];
  projectIds: string[];
  keyResultId: string | null;
  initiativeId: string | null;
  projectId: string | null;
};

type ChatMessage = { id: string; role: "user" | "assistant"; content: string };
type ConversationMode = "okr" | "project" | "routine" | "task" | "onboarding" | "coach";

type AssistantConversationDraft = {
  version: 1;
  message: string;
  plan: OnboardingPlan;
  guideQuestions: string[];
  conversationHistory: ChatMessage[];
  visibleFields: StringPlanField[];
  mode: ConversationMode;
  okrTarget: OkrPlanTarget | null;
  targetCandidates: OkrPlanTarget[];
  projectTarget: ProjectChatTarget | null;
  projectDriMemberId: string;
  routineAssigneeMemberId: string;
  taskContainer: string;
  taskAssigneeMemberId: string;
};

type OrganizeError = {
  code?: string;
  error?: string;
  spentWon?: number;
  limitWon?: number;
  usage?: { spentWon?: number; budgetWon?: number; remainingWon?: number; requestsToday?: number };
  options?: string[];
};

type TeamMember = {
  id: string;
  email: string;
  displayName: string;
  role: TeamRole;
  status: "active";
  isCurrent: boolean;
  createdAt: string;
};

type TeamInvitation = {
  id: string;
  email: string;
  displayName: string;
  role: Exclude<TeamRole, "owner">;
  status: "pending" | "expired";
  deliveryStatus: "not_sent" | "sent" | "failed" | "unavailable";
  expiresAt: string;
  lastSentAt: string | null;
  createdAt: string;
};

type InvitationPreview = {
  workspace: { id: string; name: string };
  role: Exclude<TeamRole, "owner">;
  inviterName: string;
  emailHint: string;
  status: "pending" | "expired" | "accepted" | "revoked";
  expiresAt: string;
};

type WorkspaceGroup = {
  id: string;
  name: string;
  handle: string;
  description: string;
  color: GroupColor;
  visibility: GroupVisibility;
  archived: boolean;
  memberCount: number;
  isMember: boolean;
  isLead: boolean;
  canEdit: boolean;
  canArchive: boolean;
  createdAt: string;
  updatedAt: string;
};

type GroupMember = {
  id: string;
  memberId: string;
  email: string;
  displayName: string;
  status: "invited" | "active";
  workspaceRole: TeamRole;
  groupRole: GroupRole;
  isCurrent: boolean;
  createdAt: string;
};

type TeamData = { workspace: { id: string; name: string; kind: "personal" | "team"; avatarUrl: string | null; avatarUpdatedAt: string | null }; members: TeamMember[]; invitations: TeamInvitation[]; invitationEmailConfigured: boolean; currentRole: TeamRole; canManage: boolean };
type BootstrapShellData = {
  user: AuthUser;
  workspaces: WorkspaceSummary[];
  rules: WorkspaceRules;
  cycles: OkrCycle[];
  team: TeamData;
};
type BootstrapWorkspaceData = {
  items: OkriItem[];
  properties: PropertyDefinition[];
  propertyValues: PropertyValueMap;
  hiddenByProject: ProjectHiddenPropertyMap;
  archivedProjects: ArchivedProject[];
  routines: Routine[];
};
type BootstrapData = BootstrapShellData & BootstrapWorkspaceData;
type BootstrapFetchResult = { ok: boolean; status: number; data: BootstrapData | null };

declare global {
  interface Window {
    __OKRI_BOOTSTRAP_REQUEST__?: {
      path: string;
      request: Promise<BootstrapFetchResult>;
    };
    PaypleCpayAuthCheck?: (options: Record<string, unknown>, environment?: string) => void;
  }
}

async function fetchBootstrapPayload(path: string): Promise<BootstrapFetchResult> {
  const response = await fetch(path, { cache: "no-store", credentials: "same-origin", headers: displayLanguageHeaders() });
  return {
    ok: response.ok,
    status: response.status,
    data: await response.json().catch(() => null) as BootstrapData | null,
  };
}

const BOOTSTRAP_CACHE_KEY = "okri.bootstrap.v1";
const BOOTSTRAP_CACHE_TTL_MS = 30 * 60 * 1000;

function readCachedBootstrap(path: string): BootstrapData | null {
  if (new URLSearchParams(window.location.search).has("auth")) return null;
  try {
    const raw = window.localStorage.getItem(BOOTSTRAP_CACHE_KEY);
    if (!raw) return null;
    const cached = JSON.parse(raw) as { path?: string; savedAt?: number; data?: BootstrapData };
    if (cached.path !== path || typeof cached.savedAt !== "number" || Date.now() - cached.savedAt > BOOTSTRAP_CACHE_TTL_MS || !cached.data?.user || !Array.isArray(cached.data.items)) {
      window.localStorage.removeItem(BOOTSTRAP_CACHE_KEY);
      return null;
    }
    return cached.data;
  } catch {
    clearCachedBootstrap();
    return null;
  }
}

function writeCachedBootstrap(path: string, data: BootstrapData) {
  try {
    window.localStorage.setItem(BOOTSTRAP_CACHE_KEY, JSON.stringify({ path, savedAt: Date.now(), data }));
  } catch {
    clearCachedBootstrap();
  }
}

function clearCachedBootstrap() {
  try { window.localStorage.removeItem(BOOTSTRAP_CACHE_KEY); } catch { /* Storage is optional, including during sign-in. */ }
}
type GroupDetailData = { group: WorkspaceGroup; members: GroupMember[]; canManageMembers: boolean };
type WorkspaceSummary = {
  id: string;
  name: string;
  createdAt: string;
  kind: "personal" | "team";
  personal: boolean;
  role: TeamRole;
  current: boolean;
  deletionRequestedAt: string | null;
  scheduledDeletionAt: string | null;
  avatarUrl: string | null;
  avatarUpdatedAt: string | null;
};
type GoogleConnectionStatus = {
  configured: boolean;
  connected: boolean;
  email: string | null;
  displayName: string | null;
  scope: string;
  connectedAt: string | null;
  updatedAt: string | null;
};
type SlackConnectionStatus = {
  connected: boolean;
  state: "service_unavailable" | "workspace_disconnected" | "setup_required" | "connected" | "reauthorization_required" | "error";
  statusMessage: string;
  missingScopes: string[];
  connectionScope: "workspace";
  distributionMode: "direct_oauth";
  connectedTeam: { id: string; name: string } | null;
  teamName: string | null;
  teamId: string | null;
  botUserId: string | null;
  scope: string;
  connectedAt: string | null;
  updatedAt: string | null;
  redirectUrl: string;
  commandUrl: string;
  interactionUrl?: string | null;
  eventsUrl?: string | null;
};
type IntegrationStatusCache = {
  workspaceId: string;
  savedAt: number;
  google: GoogleConnectionStatus | null;
  slack: SlackConnectionStatus | null;
};
const INTEGRATION_STATUS_CACHE_KEY = "okri.integration-status.v1";
const INTEGRATION_STATUS_CACHE_TTL_MS = 10 * 60 * 1000;

function readCachedIntegrationStatuses(workspaceId: string): IntegrationStatusCache | null {
  if (!workspaceId) return null;
  try {
    const raw = window.sessionStorage.getItem(INTEGRATION_STATUS_CACHE_KEY);
    if (!raw) return null;
    const cached = JSON.parse(raw) as IntegrationStatusCache;
    if (cached.workspaceId !== workspaceId || Date.now() - cached.savedAt > INTEGRATION_STATUS_CACHE_TTL_MS) {
      window.sessionStorage.removeItem(INTEGRATION_STATUS_CACHE_KEY);
      return null;
    }
    return cached;
  } catch {
    window.sessionStorage.removeItem(INTEGRATION_STATUS_CACHE_KEY);
    return null;
  }
}

function writeCachedIntegrationStatuses(workspaceId: string, google: GoogleConnectionStatus | null, slack: SlackConnectionStatus | null) {
  if (!workspaceId || (!google && !slack)) return;
  try {
    window.sessionStorage.setItem(INTEGRATION_STATUS_CACHE_KEY, JSON.stringify({ workspaceId, savedAt: Date.now(), google, slack } satisfies IntegrationStatusCache));
  } catch {
    window.sessionStorage.removeItem(INTEGRATION_STATUS_CACHE_KEY);
  }
}
type ManagementBotSignal = "missing_due_date" | "missing_owner" | "overdue" | "completed_yesterday" | "due_today";
type ManagementBotProject = { id: string; title: string; status: string; dueDate: string | null; isOverdue: boolean };
type ManagementBotItem = { id: string; kind: "project" | "task"; title: string; status: string; dueDate: string | null; isOverdue: boolean; parentProject: ManagementBotProject | null };
type ManagementBotProjectGroup = { project: ManagementBotProject | null; projectMatchesSignal: boolean; tasks: ManagementBotItem[] };
type ManagementBotSettings = { enabled: boolean; weekdays: number[]; reportTime: string; timezone: string; channelId: string; channelName: string; signals: ManagementBotSignal[]; lastSentDate: string | null; lastSentAt: string | null; lastError: string; updatedAt: string | null };
type ManagementBotSnapshot = { date: string; groups: Array<{ signal: ManagementBotSignal; count: number; items: ManagementBotItem[]; projects: ManagementBotProjectGroup[] }>; totalCount: number };
type SlackChannelOption = { id: string; name: string; isPrivate: boolean; isMember: boolean; isShared: boolean; isExternal: boolean };
const SLACK_CHANNEL_REFRESH_MS = 15_000;

function slackChannelKindLabel(channel: SlackChannelOption) {
  if (channel.isExternal) return t("Slack Connect · 봇 참여 중");
  if (channel.isShared) return t("조직 공유 · 봇 참여 중");
  if (channel.isPrivate) return t("비공개 · 봇 참여 중");
  return channel.isMember ? t("공개 · 봇 참여 중") : t("공개 · 선택 시 참여");
}

function slackChannelOptionLabel(channel: SlackChannelOption) {
  if (channel.isExternal) return t("#{value1} · Slack Connect", { value1: messageValue(channel.name) });
  if (channel.isShared) return t("#{value1} · 조직 공유", { value1: messageValue(channel.name) });
  if (channel.isPrivate) return t("#{value1} · 비공개", { value1: messageValue(channel.name) });
  return `#${channel.name}`;
}

async function fetchSlackChannelOptions(signal?: AbortSignal) {
  const response = await fetch("/api/slack/channels?joinable=1", { cache: "no-store", signal });
  const data = await response.json() as { channels?: SlackChannelOption[]; error?: string };
  if (!response.ok) throw new Error(data.error || "Slack 채널을 불러오지 못했습니다.");
  return data.channels ?? [];
}

function useLiveSlackChannels(enabled: boolean) {
  const [channels, setChannels] = useState<SlackChannelOption[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(false);
  const requestRef = useRef<AbortController | null>(null);

  const refresh = useCallback(async (silent = false) => {
    requestRef.current?.abort();
    const controller = new AbortController();
    requestRef.current = controller;
    if (!silent) setLoading(true);
    try {
      const nextChannels = await fetchSlackChannelOptions(controller.signal);
      if (controller.signal.aborted) return;
      setChannels(nextChannels);
      setError(false);
    } catch (refreshError) {
      if (refreshError instanceof DOMException && refreshError.name === "AbortError") return;
      if (!controller.signal.aborted) setError(true);
    } finally {
      if (requestRef.current === controller) {
        requestRef.current = null;
        if (!silent) setLoading(false);
      }
    }
  }, []);

  useEffect(() => {
    if (!enabled) {
      requestRef.current?.abort();
      requestRef.current = null;
      return;
    }
    const initialTimer = window.setTimeout(() => void refresh(false), 0);
    const refreshQuietly = () => { if (document.visibilityState === "visible") void refresh(true); };
    const handleVisibilityChange = () => { if (document.visibilityState === "visible") void refresh(true); };
    const timer = window.setInterval(refreshQuietly, SLACK_CHANNEL_REFRESH_MS);
    window.addEventListener("focus", refreshQuietly);
    document.addEventListener("visibilitychange", handleVisibilityChange);
    return () => {
      window.clearTimeout(initialTimer);
      window.clearInterval(timer);
      window.removeEventListener("focus", refreshQuietly);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      requestRef.current?.abort();
      requestRef.current = null;
    };
  }, [enabled, refresh]);

  return { channels, setChannels, loading, error, refresh };
}

function SlackChannelSyncStatus({ loading, error, onRefresh }: { loading: boolean; error: boolean; onRefresh: () => void }) {
  return <div className={`slack-channel-sync ${error ? "error" : ""}`} aria-live="polite">
    <span>{error ? t("Slack 채널 변경사항을 확인하지 못했습니다.") : t("Slack 변경사항을 15초마다 자동 반영합니다.")}</span>
    <button className="secondary" type="button" disabled={loading} aria-busy={loading} onClick={onRefresh}>{loading ? <LoaderCircle className="spin" size={13} /> : <RefreshCw size={13} />}{loading ? t("확인 중") : t("새로고침")}</button>
  </div>;
}

type ManagementBotData = {
  settings: ManagementBotSettings;
  snapshot?: ManagementBotSnapshot;
  slackConnected: boolean;
  channels: SlackChannelOption[];
};
type SlackOAuthIssue = "workspace_admin_required" | "slack_admin_approval_required" | "workspace_already_connected" | "authorization_cancelled" | "missing_scope" | "oauth_exchange_failed" | "service_unavailable";
const slackOAuthIssueCopy: Record<SlackOAuthIssue, { title: string; detail: string; tone: "warning" | "error" }> = {
  workspace_admin_required: { title: "OKRI 관리자 권한이 필요합니다", detail: "이 워크스페이스의 Owner 또는 Admin에게 Slack 연결을 요청해 주세요.", tone: "warning" },
  slack_admin_approval_required: { title: "Slack 관리자 승인이 필요합니다", detail: "선택한 Slack 워크스페이스의 앱 설치 정책에 따라 관리자 승인을 받은 뒤 다시 연결해 주세요.", tone: "warning" },
  workspace_already_connected: { title: "이미 다른 OKRI 워크스페이스에 연결된 Slack입니다", detail: "기존 OKRI 워크스페이스에서 연결을 해제한 뒤 다시 시도해 주세요.", tone: "warning" },
  authorization_cancelled: { title: "Slack 승인이 취소되었습니다", detail: "연결할 워크스페이스를 다시 선택하려면 아래 연결 버튼을 눌러 주세요.", tone: "warning" },
  missing_scope: { title: "Slack 권한 업데이트가 필요합니다", detail: "데일리 DM과 채널 공유에 필요한 권한을 Slack에서 한 번 더 승인해 주세요.", tone: "warning" },
  oauth_exchange_failed: { title: "Slack 연결을 완료하지 못했습니다", detail: "승인 정보가 만료되었거나 Slack 응답을 확인하지 못했습니다. 다시 연결해 주세요.", tone: "error" },
  service_unavailable: { title: "Slack 연결을 잠시 사용할 수 없습니다", detail: "별도로 입력할 설정은 없습니다. 서비스가 준비되면 이 화면에서 바로 연결할 수 있습니다.", tone: "error" },
};
type SlackAutomationTrigger = "task_created" | "task_status_changed" | "task_changed";
type SlackAutomation = {
  id: string;
  name: string;
  triggerType: SlackAutomationTrigger;
  triggerStatus: string;
  channelId: string;
  messageTemplate: string;
  messageTemplateKind?: "custom" | "default" | "blocked";
  supported?: boolean;
  active: boolean;
  lastTriggeredAt: string | null;
  lastDeliveryStatus: "never" | "pending" | "sent" | "failed";
  lastError: string;
  createdAt: string;
  updatedAt: string;
};
type SlackAutomationDelivery = {
  id: string;
  automationId: string;
  itemId: string | null;
  triggerType: string;
  channelId: string;
  message: string;
  status: "pending" | "sent" | "failed";
  error: string;
  createdAt: string;
  sentAt: string | null;
};

type TrashRecord = {
  id: string;
  category: string;
  title: string;
  itemCount: number;
  routineCount: number;
  cycleCount: number;
  archivedAt: string;
};

const dailyScrumMemoryCache = new Map<string, DailyDashboard>();
const recommendationMemoryCache = new Map<string, Recommendation[]>();
const routineMemoryCache = new Map<string, Routine[]>();
const projectTemplateMemoryCache = new Map<string, ProjectTemplate[]>();
const propertyCatalogMemoryCache = new Map<string, PropertyDefinition[]>();
const trashMemoryCache = new Map<string, { records: TrashRecord[]; items: TrashedItem[]; initiativeOptions: TrashInitiativeOption[] }>();
const viewCacheTimestamps = new Map<string, number>();
const VIEW_CACHE_FRESH_MS = 30_000;

function viewCacheIsFresh(key: string) {
  const storedAt = viewCacheTimestamps.get(key);
  return typeof storedAt === "number" && Date.now() - storedAt < VIEW_CACHE_FRESH_MS;
}

function markViewCacheFresh(key: string) {
  viewCacheTimestamps.set(key, Date.now());
}

function scrumNotesSnapshot(scrum: DailyDashboard) {
  return JSON.stringify(scrum.draft);
}

function dailySkipLabel(reason: DailySkipReason) {
  return t({ workload: "본업 과중", vacation: "휴가", personal: "개인 일정", other: "기타" }[reason]);
}

type IntroLanguage = Language;

type IntroCopy = {
  languageLabel: string;
  eyebrow: string;
  title: string;
  description: string;
  hierarchyLabel: string;
  routineNote: string;
  points: { title: string; description: string }[];
  mcpAction: string;
  startAction: string;
};

const introLanguages = languages;

function getIntroCopy(translate: (key: string) => string): IntroCopy { return {"languageLabel": translate("안내 언어"), "eyebrow": translate("목표를 실행으로 바꾸는 워크스페이스"), "title": translate("OKR이 오늘의 일로 이어지도록."), "description": translate("OKRI은 목표, 프로젝트, 할 일과 Routine을 한곳에 연결하고 대화와 봇에서도 바로 기록할 수 있는 실행 관리 서비스입니다."), "hierarchyLabel": translate("목표에서 실행까지"), "routineNote": translate("Routine은 Project처럼 Task를 담는 실행 컨테이너지만 OKR 계층과 독립적입니다."), "points": [{"title": translate("대화에서 바로 등록"), "description": translate("MCP를 연결하면 AI 대화와 봇에서 Task, 프로젝트, Routine을 바로 만들 수 있습니다.")}, {"title": translate("책임과 맥락을 선명하게"), "description": translate("Project의 책임자와 속성, Task의 담당자와 소속을 한눈에 관리합니다.")}, {"title": translate("매일 실행을 놓치지 않게"), "description": translate("Routine, 데일리 스크럼과 추천이 지금 집중할 일을 정리해 줍니다.")}], "mcpAction": translate("MCP 연결 보기"), "startAction": translate("워크스페이스 시작")}; }

const navItems: { id: View; label: string; icon: LucideIcon }[] = [
  { id: "home", get label() { return t("AI 대화"); }, icon: Bot },
  { id: "my_work", get label() { return t("내 업무"); }, icon: Briefcase },
  { id: "okr", label: "OKR", icon: Target },
  { id: "work", get label() { return t("Project"); }, icon: Table2 },
  { id: "gantt", get label() { return t("간트"); }, icon: ChartGantt },
  { id: "inbox", get label() { return t("Task"); }, icon: Inbox },
  { id: "routines", get label() { return t("Routine"); }, icon: Repeat2 },
  { id: "data", get label() { return t("데이터"); }, icon: Database },
  { id: "scrum", get label() { return t("데일리"); }, icon: CalendarCheck },
  { id: "recommendations", get label() { return t("추천"); }, icon: Lightbulb },
  { id: "reviews", get label() { return t("리뷰"); }, icon: Activity },
  { id: "trash", get label() { return t("휴지통"); }, icon: Trash2 },
];

const mobileNavItems = (["home", "okr", "my_work", "work", "inbox"] satisfies View[])
  .map((id) => navItems.find((entry) => entry.id === id)!);
const mobileMoreItems = navItems.filter((entry) => !mobileNavItems.some((mobileEntry) => mobileEntry.id === entry.id));

const cadenceLabels: Record<Cadence, string> = { get daily() { return t("일간"); }, get weekly() { return t("주간"); }, get monthly() { return t("월간"); }, get quarterly() { return t("분기"); } };
const viewTitles: Record<View, string> = {
  get home() { return t("AI 대화"); },
  get inbox() { return t("Task"); },
  get my_work() { return t("내 업무"); },
  get work() { return t("Project"); },
  get gantt() { return t("간트"); },
  get routines() { return t("Routine"); },
  okr: "OKR",
  get data() { return t("데이터"); },
  get scrum() { return t("데일리 스크럼"); },
  get recommendations() { return t("추천"); },
  get reviews() { return t("리뷰"); },
  get trash() { return t("휴지통"); },
  get integrations() { return t("개인 앱 연동"); },
  get billing() { return t("요금제 및 결제"); },
};

export default function Home() {
  useLanguage();
  return <ConfirmationProvider><WorkspaceApp /></ConfirmationProvider>;
}

function ClientDataView(props: DataViewProps) {
  const [ViewComponent, setViewComponent] = useState<ComponentType<DataViewProps> | null>(null);
  useEffect(() => {
    let active = true;
    void import("@/app/kr-data-view").then((module) => { if (active) setViewComponent(() => module.default); });
    return () => { active = false; };
  }, []);
  return ViewComponent ? <ViewComponent {...props} /> : <AsyncState icon={LoaderCircle} title={t("데이터 화면을 준비하는 중입니다")} loading />;
}

function WorkspaceApp() {
  const language = useLanguage();
  const [languageFailure, setLanguageFailure] = useState<{ userId: string; preferences: LanguagePreferences } | null>(null);
  const confirmAction = useAppConfirm();
  const [items, setItems] = useState<OkriItem[]>([]);
  const [properties, setProperties] = useState<PropertyDefinition[]>([]);
  const [propertyValues, setPropertyValues] = useState<PropertyValueMap>({});
  const [hiddenProperties, setHiddenProperties] = useState<ProjectHiddenPropertyMap>({});
  const [teamData, setTeamData] = useState<TeamData | null>(null);
  const [inviteToken, setInviteToken] = useState<string | null>(() => invitationTokenFromLocation());
  const [invitePreview, setInvitePreview] = useState<InvitationPreview | null>(null);
  const [inviteLoadError, setInviteLoadError] = useState("");
  const [routines, setRoutines] = useState<Routine[]>([]);
  const [okrCycles, setOkrCycles] = useState<OkrCycle[]>([]);
  const [selectedOkrCycleId, setSelectedOkrCycleId] = useState<string | null>(() => typeof window === "undefined" ? null : new URLSearchParams(window.location.search).get("cycle"));
  const [searchOpen, setSearchOpen] = useState(() => typeof window !== "undefined" && new URLSearchParams(window.location.search).get("search") === "1");
  const [searchFocusId, setSearchFocusId] = useState<string | null>(() => typeof window === "undefined" ? null : new URLSearchParams(window.location.search).get("focus"));
  const [searchNavigationId, setSearchNavigationId] = useState(0);
  const [, setVisibleOkrCycleIds] = useState<string[]>([]);
  const [activeView, setActiveView] = useState<View>(() => navigationFromLocation().view);
  const [cadence, setCadence] = useState<Cadence>("weekly");
  const [taskDisplay, setTaskDisplay] = useState<"cards" | "table" | "board">("table");
  const [notice, setNotice] = useState<AppNotice | null>(null);
  const [integrationOpen, setIntegrationOpen] = useState(() => typeof window !== "undefined" && new URLSearchParams(window.location.search).get("settings") === "ai");
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [propertyPanelOpen, setPropertyPanelOpen] = useState(() => typeof window !== "undefined" && new URLSearchParams(window.location.search).get("settings") === "personal");
  const [routineEditorDirty, setRoutineEditorDirty] = useState(false);
  const [workspaceAvatarOpen, setWorkspaceAvatarOpen] = useState(false);
  const [profilePromptMember, setProfilePromptMember] = useState<TeamMember | null>(null);
  const [requestedGroupHandle, setRequestedGroupHandle] = useState<string | null>(null);
  const [workspaces, setWorkspaces] = useState<WorkspaceSummary[]>([]);
  const [workspaceRules, setWorkspaceRules] = useState<WorkspaceRules | null>(null);
  const [workspaceMenuOpen, setWorkspaceMenuOpen] = useState(false);
  const [workspaceSettingsOpen, setWorkspaceSettingsOpen] = useState(() => workspaceSettingsFromLocation().open);
  const [workspaceSettingsTab, setWorkspaceSettingsTab] = useState<WorkspaceSettingsTab>(() => workspaceSettingsFromLocation().tab);
  const [workspaceCreateOpen, setWorkspaceCreateOpen] = useState(false);
  const [newWorkspaceName, setNewWorkspaceName] = useState("");
  const [workspaceSaving, setWorkspaceSaving] = useState(false);
  const [createItemOpen, setCreateItemOpen] = useState(false);
  const [routineCreateOpen, setRoutineCreateOpen] = useState(false);
  const [createItemKind, setCreateItemKind] = useState<ItemKind>("task");
  const [createItemCycleId, setCreateItemCycleId] = useState<string | null>(null);
  const [okrCreating, setOkrCreating] = useState(false);
  const [okrEditorDirty, setOkrEditorDirty] = useState(false);
  const [okrChatContext, setOkrChatContext] = useState<OkrChatContext | null>(null);
  const [deletingOkrCycleIds, setDeletingOkrCycleIds] = useState<Set<string>>(new Set());
  const [slowDeletingOkrCycleId, setSlowDeletingOkrCycleId] = useState<string | null>(null);
  const [okrListOpen, setOkrListOpen] = useState(false);
  const [cleanupOpen, setCleanupOpen] = useState(false);
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(() => navigationFromLocation().taskId);
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(() => navigationFromLocation().projectId);
  const [selectedDeleteItemIds, setSelectedDeleteItemIds] = useState<Set<string>>(new Set());
  const [trashingItems, setTrashingItems] = useState(false);
  const [googleStatus, setGoogleStatus] = useState<GoogleConnectionStatus | null>(null);
  const [slackStatus, setSlackStatus] = useState<SlackConnectionStatus | null>(null);
  const [slackOAuthIssue, setSlackOAuthIssue] = useState<SlackOAuthIssue | null>(null);
  const [integrationStatusesLoaded, setIntegrationStatusesLoaded] = useState(false);
  const [integrationStatusRefreshing, setIntegrationStatusRefreshing] = useState(false);
  const [integrationStatusAttempt, setIntegrationStatusAttempt] = useState(0);
  const [integrationStatusError, setIntegrationStatusError] = useState(false);
  const [onboardingOpen, setOnboardingOpen] = useState(false);
  const [setupOpen, setSetupOpen] = useState(false);
  const setupHandledAccount = useRef<string | null>(null);
  const [authState, setAuthState] = useState<AuthState>({ status: "loading", user: null, reason: null });
  const [workspaceDataState, setWorkspaceDataState] = useState<"loading" | "ready" | "error">("loading");
  const [freshWorkspaceDataReady, setFreshWorkspaceDataReady] = useState(false);
  const [workspaceDataAttempt, setWorkspaceDataAttempt] = useState(0);
  const [themeMode, setThemeMode] = useState<ThemeMode>(() => {
    if (typeof document === "undefined") return DEFAULT_THEME;
    const preference = document.documentElement.dataset.themePreference;
    return isThemeMode(preference) ? preference : DEFAULT_THEME;
  });
  const workspaceNameInputRef = useRef<HTMLInputElement>(null);
  const assistantAutoHandledWorkspaceRef = useRef<string | null>(null);
  const workspaceRefreshAtRef = useRef(0);
  const showNotice = useCallback((message: string, tone?: NoticeTone) => {
    const resolvedTone = tone ?? (/못했|실패|오류|찾을 수 없/.test(message) ? "error" : "success");
    const nextNotice = { id: Date.now(), message, tone: resolvedTone };
    setNotice(nextNotice);
    window.setTimeout(() => setNotice((current) => current?.id === nextNotice.id ? null : current), resolvedTone === "error" ? 7000 : 3000);
  }, []);

  useEffect(() => {
    try { window.localStorage.setItem(THEME_STORAGE_KEY, themeMode); } catch { /* A blocked preference store must not prevent theme switching. */ }
    document.documentElement.dataset.themePreference = themeMode;
    document.documentElement.dataset.theme = themeMode;
    document.documentElement.style.colorScheme = themeColorScheme(themeMode);
  }, [themeMode]);

  useEffect(() => {
    const timeout = window.setTimeout(() => {
      if (window.matchMedia("(max-width: 700px)").matches) setTaskDisplay("cards");
    }, 0);
    return () => window.clearTimeout(timeout);
  }, []);

  useEffect(() => {
    let active = true;
    workspaceRefreshAtRef.current = Date.now();
    const date = encodeURIComponent(localDate());
    const path = `/api/bootstrap?date=${date}`;
    const preload = window.__OKRI_BOOTSTRAP_REQUEST__;
    const request = workspaceDataAttempt === 0 && preload?.path === path
      ? preload.request
      : fetchBootstrapPayload(path);

    const applyBootstrapData = async (data: BootstrapData, fresh = false) => {
      if (!active) return;
      try {
        await applyAccountLanguage(data.user.id, data.user.preferences);
        if (active) setLanguageFailure(null);
      } catch {
        if (active && data.user.preferences) setLanguageFailure({ userId: data.user.id, preferences: data.user.preferences });
      }
      if (!active) return;
      setWorkspaces(data.workspaces);
      setWorkspaceRules(data.rules);
      setOkrCycles(data.cycles);
      setTeamData(data.team);
      setItems(data.items);
      setProperties(data.properties);
      setPropertyValues(data.propertyValues);
      setHiddenProperties(data.hiddenByProject ?? {});
      setRoutines(data.routines);
      const activeCycle = data.cycles.find((cycle) => cycle.status === "active") ?? data.cycles[0];
      setVisibleOkrCycleIds(activeCycle ? [activeCycle.id] : []);
      const currentMember = data.team.members.find((member) => member.isCurrent && member.status === "active");
      if (!data.user.onboarding && currentMember && memberNameNeedsConfirmation(currentMember) && window.localStorage.getItem(profileNameConfirmationKey(currentMember)) !== currentMember.displayName) {
        setProfilePromptMember(currentMember);
      }
      setAuthState({ status: "authenticated", user: data.user, reason: null });
      setWorkspaceDataState("ready");
      if (fresh) setFreshWorkspaceDataReady(true);
    };

    const cachedData = workspaceDataAttempt === 0 ? readCachedBootstrap(path) : null;
    if (cachedData) void applyBootstrapData(cachedData).catch(() => undefined);

    void request
      .then(async (result) => {
        if (!result.ok || !result.data) throw new Error(result.status === 401 || result.status === 403 ? "unauthenticated" : "workspace data unavailable");
        const data = result.data;
        workspaceRefreshAtRef.current = Date.now();
        writeCachedBootstrap(path, data);
        await applyBootstrapData(data, true);
      })
      .catch((error: unknown) => {
        if (!active) return;
        if (error instanceof Error && error.message === "unauthenticated") {
          clearCachedBootstrap();
          clearAccountLanguage();
          setLanguageFailure(null);
          void applyGuestLanguage().catch(() => undefined);
          const reason = new URLSearchParams(window.location.search).get("auth");
          setAuthState({ status: "unauthenticated", user: null, reason });
          return;
        }
        if (cachedData) return;
        setWorkspaceDataState("error");
        setAuthState({ status: "unauthenticated", user: null, reason: "load_failed" });
      });
    return () => { active = false; };
  }, [workspaceDataAttempt]);

  useEffect(() => {
    const userId = authState.user?.id;
    if (!userId || typeof BroadcastChannel === "undefined") return;
    const channel = new BroadcastChannel("okri-language");
    const controller = new AbortController();
    channel.onmessage = (event: MessageEvent<{ userId?: string }>) => {
      if (event.data?.userId !== userId) return;
      void fetch("/api/account/preferences", { cache: "no-store", headers: displayLanguageHeaders(), signal: controller.signal }).then(async (response) => {
        if (!response.ok) return;
        const data = await response.json() as { preferences?: LanguagePreferences };
        if (!controller.signal.aborted && data.preferences) await applyAccountLanguage(userId, data.preferences);
      }).catch(() => undefined);
    };
    return () => { controller.abort(); channel.close(); };
  }, [authState.user?.id]);

  useEffect(() => {
    if (authState.status !== "authenticated") return;
    const refreshIfStale = () => {
      if (document.visibilityState !== "visible" || Date.now() - workspaceRefreshAtRef.current < VIEW_CACHE_FRESH_MS) return;
      workspaceRefreshAtRef.current = Date.now();
      setWorkspaceDataAttempt((current) => current + 1);
    };
    refreshIfStale();
    document.addEventListener("visibilitychange", refreshIfStale);
    return () => document.removeEventListener("visibilitychange", refreshIfStale);
  }, [activeView, authState.status]);

  useEffect(() => {
    const group = new URLSearchParams(window.location.search).get("group")?.replace(/^@/, "").trim();
    if (!group) return;
    const timeout = window.setTimeout(() => {
      setRequestedGroupHandle(group);
      setWorkspaceSettingsTab("groups");
      setWorkspaceSettingsOpen(true);
      const url = new URL(window.location.href);
      url.searchParams.set("settings", "workspace");
      url.searchParams.set("tab", "groups");
      window.history.replaceState({ ...window.history.state, __okriWorkspaceSettings: true }, "", url);
    }, 0);
    return () => window.clearTimeout(timeout);
  }, []);

  useEffect(() => {
    if (authState.status !== "authenticated" || !inviteToken) return;
    const controller = new AbortController();
    void fetch(`/api/invitations/preview?token=${encodeURIComponent(inviteToken)}`, { signal: controller.signal, cache: "no-store" })
      .then(async (response) => {
        const data = await response.json() as { invitation?: InvitationPreview; error?: string };
        if (!response.ok || !data.invitation) throw new Error(apiError(data, "초대를 불러오지 못했습니다."));
        setInvitePreview(data.invitation);
      })
      .catch((error: unknown) => {
        if (!(error instanceof DOMException && error.name === "AbortError")) setInviteLoadError(error instanceof Error ? error.message : t("초대를 불러오지 못했습니다."));
      });
    return () => controller.abort();
  }, [authState.status, inviteToken]);

  const integrationWorkspaceId = workspaces.find((workspace) => workspace.current)?.id ?? workspaces[0]?.id ?? "";

  useEffect(() => {
    const needsIntegrationStatus = activeView === "integrations" || (workspaceSettingsOpen && workspaceSettingsTab === "integrations");
    if (authState.status !== "authenticated" || !needsIntegrationStatus || !integrationWorkspaceId) return;
    let active = true;
    const controller = new AbortController();
    const cached = readCachedIntegrationStatuses(integrationWorkspaceId);
    let nextGoogle = cached?.google ?? null;
    let nextSlack = cached?.slack ?? null;
    // Cached status is provisional; render it without blocking user interaction
    // while the authoritative requests below refresh it.
    startTransition(() => {
      setGoogleStatus(cached?.google ?? null);
      setSlackStatus(cached?.slack ?? null);
      setIntegrationStatusesLoaded(Boolean(cached));
      setIntegrationStatusRefreshing(true);
      setIntegrationStatusError(false);
    });

    const googleRequest = fetch("/api/google/status", { cache: "no-store", signal: controller.signal }).then(async (response) => {
      if (!response.ok) throw new Error("Google status unavailable");
      const data = await response.json() as { google: GoogleConnectionStatus };
      nextGoogle = data.google;
      if (active) setGoogleStatus(data.google);
    });
    const slackRequest = fetch("/api/slack/status", { cache: "no-store", signal: controller.signal }).then(async (response) => {
      if (!response.ok) throw new Error("Slack status unavailable");
      const data = await response.json() as { slack: SlackConnectionStatus };
      nextSlack = data.slack;
      if (active) setSlackStatus(data.slack);
    });

    void Promise.allSettled([googleRequest, slackRequest]).then((results) => {
      if (!active) return;
      setIntegrationStatusError(results.some((result) => result.status === "rejected"));
      setIntegrationStatusesLoaded(true);
      setIntegrationStatusRefreshing(false);
      writeCachedIntegrationStatuses(integrationWorkspaceId, nextGoogle, nextSlack);
    });
    return () => { active = false; controller.abort(); };
  }, [activeView, authState.status, integrationStatusAttempt, integrationWorkspaceId, workspaceSettingsOpen, workspaceSettingsTab]);

  useEffect(() => {
    if (activeView !== "integrations" && !(workspaceSettingsOpen && workspaceSettingsTab === "integrations")) return;
    const params = new URLSearchParams(window.location.search);
    const slackResult = params.get("slack");
    if (!slackResult) return;
    const timeout = window.setTimeout(() => {
      if (slackResult === "connected") {
        setSlackOAuthIssue(null);
        showNotice(t("선택한 Slack 워크스페이스를 연결했습니다."));
      } else if (slackResult === "setup_required") {
        setSlackOAuthIssue(null);
        showNotice(t("OKRI 연결이 완료되었습니다. 데일리 초기 설정을 마쳐 주세요."));
      } else if (Object.prototype.hasOwnProperty.call(slackOAuthIssueCopy, slackResult)) {
        const issue = slackResult as SlackOAuthIssue;
        setSlackOAuthIssue(issue);
        showNotice(t(slackOAuthIssueCopy[issue].detail), slackOAuthIssueCopy[issue].tone === "error" ? "error" : undefined);
      }
      const url = new URL(window.location.href);
      url.searchParams.delete("slack");
      window.history.replaceState(window.history.state, "", url);
    }, 0);
    return () => window.clearTimeout(timeout);
  }, [activeView, showNotice, workspaceSettingsOpen, workspaceSettingsTab]);

  useEffect(() => {
    if (workspaceMenuOpen && workspaceCreateOpen) workspaceNameInputRef.current?.focus();
  }, [workspaceMenuOpen, workspaceCreateOpen]);

  useEffect(() => {
    function syncFromHistory() {
      const next = navigationFromLocation();
      if (window.history.state?.__okriSearchOriginView === "home") next.view = "home";
      const params = new URLSearchParams(window.location.search);
      setSearchOpen(params.get("search") === "1");
      setSearchFocusId(params.get("focus"));
      if (params.has("cycle")) setSelectedOkrCycleId(params.get("cycle"));
      setPropertyPanelOpen(params.get("settings") === "personal");
      setIntegrationOpen(params.get("settings") === "ai");
      if (activeView === "okr" && next.view !== "okr" && okrEditorDirty) {
        void confirmAction({ title: t("OKR 수정 중"), message: t("저장하지 않은 OKR 변경사항을 버리고 이동할까요?"), confirmLabel: t("변경사항 버리기"), danger: true }).then((confirmed) => {
          if (!confirmed) {
            window.history.forward();
            return;
          }
          setOkrCreating(false);
          setOkrEditorDirty(false);
          setActiveView(next.view);
          setSelectedProjectId(next.projectId);
          setSelectedTaskId(next.taskId);
        });
        return;
      }
      setActiveView(next.view);
      setSelectedProjectId(next.projectId);
      setSelectedTaskId(next.taskId);
      const settings = workspaceSettingsFromLocation();
      setWorkspaceSettingsOpen(settings.open);
      setWorkspaceSettingsTab(settings.tab);
    }
    window.addEventListener("popstate", syncFromHistory);
    return () => window.removeEventListener("popstate", syncFromHistory);
  }, [activeView, confirmAction, okrEditorDirty]);

  useEffect(() => {
    if (!workspaceMenuOpen) return;
    function closeWorkspaceMenu(event: Event) {
      if (event instanceof KeyboardEvent && event.key !== "Escape") return;
      if (event instanceof MouseEvent && (event.target as Element | null)?.closest(".workspace-control")) return;
      setWorkspaceMenuOpen(false);
      setWorkspaceCreateOpen(false);
      setNewWorkspaceName("");
    }
    window.addEventListener("pointerdown", closeWorkspaceMenu);
    window.addEventListener("keydown", closeWorkspaceMenu);
    return () => {
      window.removeEventListener("pointerdown", closeWorkspaceMenu);
      window.removeEventListener("keydown", closeWorkspaceMenu);
    };
  }, [workspaceMenuOpen]);

  const teamMembers = teamData?.members ?? [];
  const activeItems = items.filter((entry) => !entry.archivedAt && entry.status !== "archived");
  const taskItems = activeItems.filter((entry) => entry.kind === "task");
  const executionItems = activeItems.filter((entry) => entry.kind === "project");
  const taskContainerOptions: TaskContainerOption[] = [
    ...executionItems.map((entry) => ({ id: entry.id, kind: "project" as const, title: entry.title })),
    ...routines.filter((entry) => entry.active && entry.systemKey !== "general").map((entry) => ({ id: entry.id, kind: "routine" as const, title: entry.title })),
  ];
  const defaultOkrCycle = okrCycles.find((cycle) => cycle.status === "active") ?? okrCycles[0] ?? null;
  const selectedOkrCycle = okrCycles.find((cycle) => cycle.id === selectedOkrCycleId) ?? defaultOkrCycle;
  const createItemCycle = okrCycles.find((cycle) => cycle.id === createItemCycleId) ?? selectedOkrCycle;
  const projectChatTargets: ProjectChatTarget[] = activeItems
    .filter((entry) => entry.kind === "initiative" && Boolean(entry.cycleId))
    .map((entry) => ({
      cycleId: entry.cycleId,
      cycleName: okrCycles.find((cycle) => cycle.id === entry.cycleId)?.name ?? "OKR",
      initiativeId: entry.id,
      initiativeTitle: entry.title,
    }));
  const okrCycleItemCounts = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const cycle of okrCycles) counts[cycle.id] = activeItems.filter((entry) => entry.cycleId === cycle.id && ["objective", "key_result", "initiative"].includes(entry.kind)).length;
    return counts;
  }, [activeItems, okrCycles]);
  const periodItems = activeItems.filter(
    (entry) => cadence === "quarterly" || entry.cadence === cadence || entry.kind === "objective",
  );
  const completed = periodItems.filter((entry) => isCompletedStatus(entry.status)).length;
  const blocked = periodItems.filter((entry) => entry.status === "blocked").length;
  const measurablePeriodItems = periodItems.filter((entry) => entry.kind !== "objective" && entry.kind !== "initiative");
  const averageProgress = measurablePeriodItems.length
    ? Math.round(measurablePeriodItems.reduce((sum, entry) => sum + entry.progress, 0) / measurablePeriodItems.length)
    : 0;
  const selectedTask = activeItems.find((entry) => entry.id === selectedTaskId && entry.kind === "task");
  const selectedProject = activeItems.find((entry) => entry.id === selectedProjectId && entry.kind === "project");
  const activeWorkspaces = workspaces.filter((entry) => !entry.scheduledDeletionAt);
  const searchDataRevision = useMemo(() => [items, routines], [items, routines]);
  const scheduledWorkspaces = workspaces.filter((entry) => Boolean(entry.scheduledDeletionAt));
  const workspaceNameCounts = workspaces.reduce((counts, workspace) => {
    const key = workspace.name.trim().toLocaleLowerCase();
    counts.set(key, (counts.get(key) ?? 0) + 1);
    return counts;
  }, new Map<string, number>());
  const currentWorkspace = activeWorkspaces.find((entry) => entry.current) ?? activeWorkspaces[0];
  const currentTeamMember = teamMembers.find((member) => member.isCurrent && member.status === "active");
  const deletableItemIds = new Set(activeItems
    .filter((item) => canUserDeleteItem(item, currentTeamMember, authState.user?.id ?? null))
    .map((item) => item.id));
  const canDeleteRecords = currentWorkspace?.role === "owner" || currentWorkspace?.role === "admin";

  useEffect(() => {
    const timeout = window.setTimeout(() => setSelectedDeleteItemIds(new Set()), 0);
    return () => window.clearTimeout(timeout);
  }, [activeView, currentWorkspace?.id, selectedProjectId, selectedTaskId]);
  const accountDisplayName = currentTeamMember?.displayName || authState.user?.displayName || "내 계정";
  const accountInitial = accountDisplayName.slice(0, 1).toLocaleUpperCase() || "O";
  const hasActiveObjective = activeItems.some((entry) => entry.kind === "objective");
  const canWriteWorkspace = currentWorkspace?.role !== "viewer";
  const assistantWorkspaceContext = useMemo(
    () => buildAssistantWorkspaceContext(activeItems, selectedOkrCycle, selectedProject ?? null),
    [activeItems, selectedOkrCycle, selectedProject],
  );
  const assistantTargeting = useMemo(
    () => deriveAssistantTargeting(assistantWorkspaceContext),
    [assistantWorkspaceContext],
  );

  function writeNavigation(view: View, projectId: string | null, taskId: string | null, mode: "push" | "replace" = "push") {
    const url = new URL(window.location.href);
    if (view === "home") url.searchParams.delete("view");
    else url.searchParams.set("view", view);
    if (projectId) url.searchParams.set("project", projectId); else url.searchParams.delete("project");
    if (taskId && !projectId) url.searchParams.set("task", taskId); else url.searchParams.delete("task");
    url.searchParams.delete("search");
    url.searchParams.delete("focus");
    const state = { ...window.history.state, __okriNavigation: true };
    delete state.__okriOverlay;
    delete state.__okriSearch;
    delete state.__okriSearchDestination;
    delete state.__okriSearchOriginView;
    window.history[mode === "push" ? "pushState" : "replaceState"](state, "", url);
  }

  function openSearch() {
    setWorkspaceMenuOpen(false);
    setSearchOpen(true);
    const url = new URL(window.location.href);
    if (url.searchParams.get("search") === "1") return;
    const originState = { ...window.history.state, __okriSearchOriginView: activeView };
    window.history.replaceState(originState, "", window.location.href);
    if (selectedOkrCycle) url.searchParams.set("cycle", selectedOkrCycle.id);
    url.searchParams.set("search", "1");
    window.history.pushState({ ...originState, __okriSearch: true }, "", url);
  }

  function closeSearch() {
    if (window.history.state?.__okriSearch) { window.history.back(); return; }
    setSearchOpen(false);
    const url = new URL(window.location.href);
    url.searchParams.delete("search");
    window.history.replaceState(window.history.state, "", url);
  }

  useEffect(() => {
    const shortcut = (event: KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey) || event.key.toLowerCase() !== "k" || event.isComposing) return;
      // Respect the top-most editor/confirmation rather than bypassing its guard.
      if (document.querySelector("dialog[open]") && !searchOpen) return;
      event.preventDefault();
      if (!searchOpen) openSearch();
      else document.querySelector<HTMLInputElement>(".workspace-search-panel input")?.focus();
    };
    window.addEventListener("keydown", shortcut);
    return () => window.removeEventListener("keydown", shortcut);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchOpen, selectedOkrCycle?.id]);

  const hydrateSearchResult = useCallback(async (kind: SearchResult["kind"], id: string, signal: AbortSignal) => {
    const response = await fetch(`/api/search/resolve?kind=${kind}&id=${encodeURIComponent(id)}&date=${localDate()}`, { signal, cache: "no-store", headers: { "x-okri-workspace-id": currentWorkspace?.id ?? "" } });
    if (!response.ok) throw new Error("search_item_unavailable");
    const data = await response.json() as { items: OkriItem[]; cycles: OkrCycle[]; routines: Routine[]; propertyValues: PropertyValueMap; hiddenByProject: ProjectHiddenPropertyMap };
    if (signal.aborted) return null;
    setItems((current) => [...current.filter((item) => !data.items.some((fresh) => fresh.id === item.id)), ...data.items]);
    setOkrCycles((current) => [...current.filter((cycle) => !data.cycles.some((fresh) => fresh.id === cycle.id)), ...data.cycles]);
    setRoutines((current) => [...current.filter((routine) => !data.routines.some((fresh) => fresh.id === routine.id)), ...data.routines]);
    if (data.routines.length) routineMemoryCache.delete(`routines:${currentWorkspace?.id}:${localDate()}`);
    setPropertyValues((current) => ({ ...current, ...data.propertyValues }));
    setHiddenProperties((current) => ({ ...current, ...data.hiddenByProject }));
    return data;
  }, [currentWorkspace?.id]);

  async function navigateSearch(target: SearchResult | SearchDestination, signal: AbortSignal) {
    if (okrEditorDirty) {
      const confirmed = await confirmAction({ title: t("OKR 수정 중"), message: t("저장하지 않은 OKR 변경사항을 버리고 이동할까요?"), confirmLabel: t("변경사항 버리기"), danger: true });
      if (!confirmed || signal.aborted) return false;
    }
    if (routineEditorDirty) {
      const confirmed = await confirmAction({ title: t("변경사항을 버릴까요?"), message: t("저장하지 않은 변경사항이 있습니다. 닫으면 작성한 내용이 사라집니다."), confirmLabel: t("변경사항 버리기"), danger: true });
      if (!confirmed || signal.aborted) return false;
    }
    const result = "kind" in target ? target : null;
    let targetCycleId = result?.cycleId ?? null;
    const destination: SearchDestination = result ? { view: result.kind === "project" ? "work" : result.kind === "task" ? "inbox" : result.kind === "routine" ? "routines" : "okr" } : target as SearchDestination;
    if (result) {
      const data = await hydrateSearchResult(result.kind, result.id, signal);
      if (!data) return false;
      targetCycleId = data.cycles[0]?.id ?? null;
      if (data.cycles[0] && destination.view === "okr") setSelectedOkrCycleId(data.cycles[0].id);
    }
    if (signal.aborted) return false;
    if (result) setSearchNavigationId((current) => current + 1);
    setOkrCreating(false); setOkrEditorDirty(false); setSearchOpen(false);
    const view = (destination.view ?? (activeView === "home" ? "okr" : activeView)) as View;
    setActiveView(view);
    setSelectedProjectId(result?.kind === "project" ? result.id : null);
    setSelectedTaskId(result?.kind === "task" ? result.id : null);
    setSearchFocusId(result && !["project", "task"].includes(result.kind) ? result.id : null);
    writeNavigation(view, result?.kind === "project" ? result.id : null, result?.kind === "task" ? result.id : null);
    const url = new URL(window.location.href);
    if (result && !["project", "task"].includes(result.kind)) url.searchParams.set("focus", result.id);
    if (targetCycleId && view === "okr") url.searchParams.set("cycle", targetCycleId);
    for (const key of ["settings", "tab", "bot"]) url.searchParams.delete(key);
    if (destination.tab) {
      url.searchParams.set("settings", "workspace"); url.searchParams.set("tab", destination.tab);
      if (destination.bot) url.searchParams.set("bot", destination.bot);
      setWorkspaceSettingsTab(destination.tab as WorkspaceSettingsTab);
    } else if (destination.personal || destination.ai) url.searchParams.set("settings", destination.personal ? "personal" : "ai");
    setWorkspaceSettingsOpen(Boolean(destination.tab));
    setPropertyPanelOpen(Boolean(destination.personal));
    setIntegrationOpen(Boolean(destination.ai));
    window.history.replaceState({ ...window.history.state, __okriSearchDestination: true }, "", url);
    return true;
  }

  function closePersonalDestination(kind: "personal" | "ai") {
    const url = new URL(window.location.href);
    if (url.searchParams.get("settings") === kind) {
      if (window.history.state?.__okriSearchDestination) { window.history.back(); return; }
      url.searchParams.delete("settings");
      window.history.replaceState(window.history.state, "", url);
    }
    if (kind === "personal") setPropertyPanelOpen(false); else setIntegrationOpen(false);
  }

  function openWorkspaceSettings(tab: WorkspaceSettingsTab = "general", mode: "push" | "replace" = "push") {
    setWorkspaceMenuOpen(false);
    setWorkspaceCreateOpen(false);
    setMobileMenuOpen(false);
    setWorkspaceSettingsTab(tab);
    setWorkspaceSettingsOpen(true);
    const url = new URL(window.location.href);
    url.searchParams.set("settings", "workspace");
    url.searchParams.set("tab", tab);
    if (tab !== "groups") url.searchParams.delete("group");
    window.history[mode === "push" ? "pushState" : "replaceState"]({ ...window.history.state, __okriWorkspaceSettings: true }, "", url);
  }

  function closeWorkspaceSettings() {
    if (window.history.state?.__okriSearchDestination) { window.history.back(); return; }
    setWorkspaceSettingsOpen(false);
    setRequestedGroupHandle(null);
    const url = new URL(window.location.href);
    url.searchParams.delete("settings");
    url.searchParams.delete("tab");
    url.searchParams.delete("group");
    const state = { ...window.history.state };
    delete state.__okriWorkspaceSettings;
    window.history.replaceState(state, "", url);
  }

  function reloadWithoutWorkspaceSettings() {
    const url = new URL(window.location.href);
    for (const key of ["settings", "tab", "group", "slack"]) url.searchParams.delete(key);
    window.location.href = url.toString();
  }

  function navigateView(view: View, mode: "push" | "replace" = "push") {
    if (activeView === "okr" && view !== "okr" && okrEditorDirty) {
      void confirmAction({ title: t("OKR 수정 중"), message: t("저장하지 않은 OKR 변경사항을 버리고 이동할까요?"), confirmLabel: t("변경사항 버리기"), danger: true }).then((confirmed) => {
        if (!confirmed) return;
        setOkrCreating(false);
        setOkrEditorDirty(false);
        setSelectedProjectId(null);
        setSelectedTaskId(null);
        setActiveView(view);
        writeNavigation(view, null, null, mode);
      });
      return;
    }
    if (view !== "okr") {
      setOkrCreating(false);
      setOkrEditorDirty(false);
    }
    setSelectedProjectId(null);
    setSelectedTaskId(null);
    setActiveView(view);
    writeNavigation(view, null, null, mode);
  }

  function refreshIntegrationStatuses() {
    setIntegrationStatusRefreshing(true);
    setIntegrationStatusError(false);
    setIntegrationStatusAttempt((attempt) => attempt + 1);
  }

  function openTaskDetail(id: string) {
    setSelectedProjectId(null);
    setSelectedTaskId(id);
    writeNavigation(activeView === "home" ? "inbox" : activeView, null, id);
  }

  function closeDetail() {
    const hasDetailParam = new URLSearchParams(window.location.search).has("project") || new URLSearchParams(window.location.search).has("task");
    if (hasDetailParam && window.history.state?.__okriNavigation) {
      window.history.back();
      return;
    }
    setSelectedProjectId(null);
    setSelectedTaskId(null);
    writeNavigation(activeView === "home" ? "okr" : activeView, null, null, "replace");
  }

  useEffect(() => {
    if (workspaceDataState !== "ready") return;
    const missingProject = selectedProjectId && !items.some((entry) => entry.id === selectedProjectId && entry.kind === "project" && !entry.archivedAt);
    const missingTask = selectedTaskId && !items.some((entry) => entry.id === selectedTaskId && entry.kind === "task" && !entry.archivedAt);
    if (!missingProject && !missingTask) return;
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort("timeout"), 12_000);
    const loadTimer = window.setTimeout(() => { void hydrateSearchResult(missingProject ? "project" : "task", (missingProject ? selectedProjectId : selectedTaskId)!, controller.signal).catch(() => {
      if (controller.signal.aborted && controller.signal.reason !== "timeout") return;
      setSelectedProjectId(null);
      setSelectedTaskId(null);
      writeNavigation(activeView === "home" ? "okr" : activeView, null, null, "replace");
      showNotice(t("요청한 상세 항목을 찾을 수 없습니다."), "error");
    }).finally(() => window.clearTimeout(timeout)); }, 0);
    return () => { window.clearTimeout(loadTimer); window.clearTimeout(timeout); controller.abort(); };
  }, [activeView, items, selectedProjectId, selectedTaskId, showNotice, workspaceDataState, hydrateSearchResult]);

  useEffect(() => {
    const user = authState.user;
    if (!freshWorkspaceDataReady || !user || setupHandledAccount.current === user.id) return;
    if (user.onboarding?.status !== "active" || !canAutoOpenSetup(window.location.search, window.location.hash)) return;
    setupHandledAccount.current = user.id;
    const timer = window.setTimeout(() => setSetupOpen(true), 0);
    return () => window.clearTimeout(timer);
  }, [authState.user, freshWorkspaceDataReady]);

  useEffect(() => {
    if (authState.user?.onboarding) return;
    if (!freshWorkspaceDataReady || !currentWorkspace || currentWorkspace.role !== "owner" || hasActiveObjective) return;
    const navigationParams = new URLSearchParams(window.location.search);
    if (navigationParams.has("view") || navigationParams.has("project") || navigationParams.has("task")) return;
    if (assistantAutoHandledWorkspaceRef.current === currentWorkspace.id) return;
    assistantAutoHandledWorkspaceRef.current = currentWorkspace.id;
    const cycle = selectedOkrCycle;
    if (!cycle) return;
    const timeout = window.setTimeout(() => {
      setOkrChatContext({
        key: `${currentWorkspace.id}:onboarding`,
        entry: "onboarding",
        cycleId: cycle.id,
        cycleName: cycle.name,
        initialMessage: "",
        target: null,
        targetCandidates: [],
      });
      setSelectedProjectId(null);
      setSelectedTaskId(null);
      setActiveView("home");
    }, 0);
    return () => window.clearTimeout(timeout);
  }, [authState.user?.onboarding, currentWorkspace, freshWorkspaceDataReady, hasActiveObjective, selectedOkrCycle]);

  function openAssistant() {
    const cycle = selectedOkrCycle;
    if (!cycle || !currentWorkspace) return;
    const entry: OkrChatContext["entry"] = currentWorkspace.role === "owner" && !hasActiveObjective ? "onboarding" : "coach";
    const key = `${currentWorkspace.id}:${entry}`;
    const targeting = assistantTargeting;
    setOkrChatContext((current) => current?.key === key ? current : {
      key,
      entry,
      cycleId: cycle.id,
      cycleName: cycle.name,
      initialMessage: "",
      target: targeting.target,
      targetCandidates: targeting.candidates,
    });
    setSelectedProjectId(null);
    setSelectedTaskId(null);
    setMobileMenuOpen(false);
    setActiveView("home");
    writeNavigation("home", null, null);
  }

  function goToMobileHome() {
    setMobileMenuOpen(false);
    navigateView("okr");
  }

  async function switchWorkspace(workspaceId: string) {
    if (workspaces.find((entry) => entry.id === workspaceId)?.scheduledDeletionAt) return;
    if (workspaceSaving || workspaceId === currentWorkspace?.id) {
      setWorkspaceMenuOpen(false);
      return;
    }
    setWorkspaceSaving(true);
    const response = await fetch("/api/workspaces", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ workspaceId }),
    });
    if (response.ok) { clearCachedBootstrap(); reloadWithoutWorkspaceSettings(); }
    else {
      setWorkspaceSaving(false);
      showNotice(t("워크스페이스를 전환하지 못했습니다."));
    }
  }

  async function createWorkspace(event: FormEvent) {
    event.preventDefault();
    const name = newWorkspaceName.trim();
    if (!name || workspaceSaving) return;
    setWorkspaceSaving(true);
    const response = await fetch("/api/workspaces", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, confirmed: true }),
    });
    if (response.ok) { clearCachedBootstrap(); reloadWithoutWorkspaceSettings(); }
    else {
      setWorkspaceSaving(false);
      showNotice(t("워크스페이스를 만들지 못했습니다."));
    }
  }

  async function deleteWorkspace(workspace: WorkspaceSummary) {
    if (workspace.personal || workspace.role !== "owner" || workspaceSaving) return;
    if (!await confirmAction({ title: t("워크스페이스 삭제 예약"), message: t("'{value1}' 워크스페이스는 바로 접근할 수 없게 되며 30일 동안 복구할 수 있습니다. 30일 후 모든 데이터가 영구 삭제됩니다.", { value1: messageValue(workspace.name) }), confirmLabel: t("삭제 예약"), danger: true })) return;
    setWorkspaceSaving(true);
    const response = await fetch(`/api/workspaces?workspaceId=${encodeURIComponent(workspace.id)}`, { method: "DELETE" });
    if (response.ok) { clearCachedBootstrap(); reloadWithoutWorkspaceSettings(); }
    else {
      const data = await response.json().catch(() => ({})) as { error?: string };
      setWorkspaceSaving(false);
      showNotice(apiError(data, "워크스페이스를 삭제하지 못했습니다."));
    }
  }

  async function restoreWorkspace(workspace: WorkspaceSummary) {
    if (!workspace.scheduledDeletionAt || workspace.role !== "owner" || workspaceSaving) return;
    setWorkspaceSaving(true);
    const response = await fetch("/api/workspaces", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "restore", workspaceId: workspace.id }),
    });
    if (response.ok) { clearCachedBootstrap(); reloadWithoutWorkspaceSettings(); }
    else {
      const data = await response.json().catch(() => ({})) as { error?: string };
      setWorkspaceSaving(false);
      showNotice(apiError(data, "워크스페이스를 복구하지 못했습니다."));
    }
  }

  async function permanentlyDeleteWorkspace(workspace: WorkspaceSummary) {
    if (!workspace.scheduledDeletionAt || workspace.role !== "owner" || workspaceSaving) return;
    if (!await confirmAction({ title: t("워크스페이스 영구 삭제"), message: t("'{value1}' 워크스페이스와 그 안의 모든 데이터를 즉시 영구 삭제합니다. 이 작업은 되돌릴 수 없습니다.", { value1: messageValue(workspace.name) }), confirmationText: workspace.name, confirmLabel: t("영구 삭제"), danger: true })) return;
    const confirmationName = workspace.name;
    setWorkspaceSaving(true);
    const response = await fetch(`/api/workspaces?workspaceId=${encodeURIComponent(workspace.id)}&permanent=true`, {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ confirmationName }),
    });
    if (response.ok) { clearCachedBootstrap(); reloadWithoutWorkspaceSettings(); }
    else {
      const data = await response.json().catch(() => ({})) as { error?: string };
      setWorkspaceSaving(false);
      showNotice(apiError(data, "워크스페이스를 영구삭제하지 못했습니다."));
    }
  }

  async function patchItem(id: string, patch: Partial<OkriItem>) {
    const previous = items;
    setItems((current) => current.map((entry) => (entry.id === id ? { ...entry, ...patch } : entry)));
    try {
      const response = await fetch("/api/items", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id, ...patch }),
      });
      if (!response.ok) throw new Error("update failed");
      const data = (await response.json()) as { item: OkriItem };
      setItems((current) => current.map((entry) => (entry.id === id ? data.item : entry)));
      return true;
    } catch {
      setItems(previous);
      showNotice(t("변경사항을 저장하지 못했습니다."));
      return false;
    }
  }

  async function setPropertyValue(itemId: string, propertyId: string, value: PropertyValue) {
    const previous = propertyValues;
    setPropertyValues((current) => ({ ...current, [itemId]: { ...current[itemId], [propertyId]: value } }));
    try {
      const response = await fetch("/api/property-values", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ itemId, propertyId, value }),
      });
      if (!response.ok) throw new Error("property save failed");
    } catch {
      setPropertyValues(previous);
      showNotice(t("속성값을 저장하지 못했습니다."));
    }
  }

  function updateItemAssignments(itemId: string, assignments: ItemAssignment[]) {
    setItems((current) => current.map((entry) => entry.id === itemId ? { ...entry, assignments } : entry));
  }

  async function setProjectPropertyVisibility(projectId: string, propertyId: string, hidden: boolean) {
    const previous = hiddenProperties;
    setHiddenProperties((current) => {
      const next = new Set(current[projectId] ?? []);
      if (hidden) next.add(propertyId); else next.delete(propertyId);
      return { ...current, [projectId]: [...next] };
    });
    const response = await fetch("/api/project-property-visibility", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ projectId, propertyId, hidden }),
    });
    if (!response.ok) {
      setHiddenProperties(previous);
      showNotice(t("속성 표시 설정을 저장하지 못했습니다."));
    }
  }

  function toggleDeleteSelection(itemId: string) {
    if (!deletableItemIds.has(itemId)) return;
    setSelectedDeleteItemIds((current) => {
      const next = new Set(current);
      if (next.has(itemId)) next.delete(itemId); else next.add(itemId);
      return next;
    });
  }

  function addDeleteItems(itemIds: string[]) {
    setSelectedDeleteItemIds((current) => new Set([...current, ...itemIds.filter((id) => deletableItemIds.has(id))]));
  }

  function removeDeleteItems(itemIds: string[]) {
    const removing = new Set(itemIds);
    setSelectedDeleteItemIds((current) => new Set([...current].filter((id) => !removing.has(id))));
  }

  async function moveSelectedItemsToTrash() {
    if (!selectedDeleteItemIds.size || trashingItems) return;
    const selected = activeItems.filter((item) => selectedDeleteItemIds.has(item.id) && deletableItemIds.has(item.id) && (item.kind === "project" || item.kind === "task"));
    const projectIds = new Set(selected.filter((item) => item.kind === "project").map((item) => item.id));
    const selectedStandaloneTaskIds = new Set(selected.filter((item) => item.kind === "task" && (!item.parentId || !projectIds.has(item.parentId))).map((item) => item.id));
    const childTaskIds = new Set(activeItems.filter((item) => item.kind === "task" && item.parentId && projectIds.has(item.parentId)).map((item) => item.id));
    const taskIds = new Set([
      ...selectedStandaloneTaskIds,
      ...childTaskIds,
    ]);
    if (!selected.length) { setSelectedDeleteItemIds(new Set()); return; }
    const message = t("선택한 Project {value1}개, 독립 Task {value2}개를 휴지통으로 이동할까요?\nProject와 함께 이동하는 하위 Task는 {value3}개이며, 중복을 제외한 전체 Task는 {value4}개입니다.\n휴지통에서 다시 복구할 수 있습니다.", { value1: messageValue(projectIds.size), value2: messageValue(selectedStandaloneTaskIds.size), value3: messageValue(childTaskIds.size), value4: messageValue(taskIds.size) });
    if (!await confirmAction({ title: t("선택 항목을 휴지통으로 이동"), message, confirmLabel: t("휴지통으로 이동"), danger: true })) return;
    setTrashingItems(true);
    try {
      const response = await fetch("/api/item-trash", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ itemIds: selected.map((item) => item.id) }),
      });
      const data = await response.json().catch(() => ({})) as { projectCount?: number; taskCount?: number; error?: string };
      if (!response.ok) throw new Error(apiError(data, "선택 항목을 휴지통으로 이동하지 못했습니다."));
      const refreshed = await fetch("/api/items", { cache: "no-store" });
      if (refreshed.ok) {
        const itemData = await refreshed.json() as { items: OkriItem[] };
        setItems(itemData.items);
      } else {
        setItems((current) => current.filter((item) => !projectIds.has(item.id) && !taskIds.has(item.id)));
      }
      clearCachedBootstrap();
      setSelectedDeleteItemIds(new Set());
      setSelectedProjectId(null);
      setSelectedTaskId(null);
      writeNavigation(activeView === "home" ? "okr" : activeView, null, null, "replace");
      showNotice(t("Project {value1}개와 Task {value2}개를 휴지통으로 이동했습니다.", { value1: messageValue(data.projectCount ?? projectIds.size), value2: messageValue(data.taskCount ?? taskIds.size) }));
    } catch (error) {
      showNotice(error instanceof Error ? error.message : t("선택 항목을 휴지통으로 이동하지 못했습니다."));
    } finally {
      setTrashingItems(false);
    }
  }

  async function archiveProjectItem(project: OkriItem) {
    if (!deletableItemIds.has(project.id)) {
      showNotice(t("Project는 생성자 또는 책임자만 삭제할 수 있습니다."), "error");
      return;
    }
    const taskCount = activeItems.filter((item) => item.kind === "task" && item.parentId === project.id).length;
    if (!await confirmAction({ title: t("Project를 휴지통으로 이동"), message: t("'{value1}' Project와 하위 Task {value2}개를 휴지통으로 이동합니다.\n휴지통에서 다시 복구할 수 있습니다.", { value1: messageValue(project.title), value2: messageValue(taskCount) }), confirmLabel: t("휴지통으로 이동"), danger: true })) return;
    const response = await fetch("/api/project-archives", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ projectId: project.id }),
    });
    if (!response.ok) {
      showNotice(t("Project를 휴지통으로 이동하지 못했습니다."));
      return;
    }
    const data = await response.json() as { project: OkriItem; archivedTaskCount: number };
    setItems((current) => current.filter((entry) => entry.id !== project.id && entry.parentId !== project.id));
    closeDetail();
    clearCachedBootstrap();
    showNotice(t("Project와 하위 Task {value1}개를 휴지통으로 이동했습니다.", { value1: messageValue(data.archivedTaskCount) }));
  }

  function openCreateItem(kind: ItemKind, cycleId: string | null = selectedOkrCycle?.id ?? null) {
    setCreateItemKind(kind);
    setCreateItemCycleId(cycleId);
    setCreateItemOpen(true);
  }

  function openOkrCreationChat(cycle: OkrCycle, sourceKind: ItemKind, initialMessage = "") {
    setCreateItemOpen(false);
    setSelectedOkrCycleId(cycle.id);
    setVisibleOkrCycleIds((current) => current.includes(cycle.id) ? current : [cycle.id, ...current]);
    setOkrChatContext({
      key: `${currentWorkspace?.id ?? "workspace"}:create:${cycle.id}:${sourceKind}`,
      entry: "create",
      cycleId: cycle.id,
      cycleName: cycle.name,
      initialMessage: initialMessage.trim(),
      sourceKind,
      target: null,
      targetCandidates: [],
    });
    setSelectedProjectId(null);
    setSelectedTaskId(null);
    setActiveView("home");
    writeNavigation("home", null, null);
  }

  function openTaskCreationChat(initialMessage = "") {
    setCreateItemOpen(false);
    setOkrChatContext({
      key: `${currentWorkspace?.id ?? "workspace"}:task`,
      entry: "task",
      cycleId: selectedOkrCycle?.id ?? "",
      cycleName: "Task",
      initialMessage: initialMessage.trim(),
      sourceKind: "task",
      target: null,
      targetCandidates: [],
    });
    setSelectedProjectId(null);
    setSelectedTaskId(null);
    setActiveView("home");
    writeNavigation("home", null, null);
  }

  function openProjectCreationChat(initialMessage = "") {
    setCreateItemOpen(false);
    setOkrChatContext({
      key: `${currentWorkspace?.id ?? "workspace"}:project`,
      entry: "project",
      cycleId: selectedOkrCycle?.id ?? "",
      cycleName: selectedOkrCycle?.name ?? "Project",
      initialMessage: initialMessage.trim(),
      sourceKind: "project",
      target: null,
      targetCandidates: [],
    });
    setSelectedProjectId(null);
    setSelectedTaskId(null);
    setActiveView("home");
    writeNavigation("home", null, null);
  }

  function openRoutineCreationChat(initialMessage = "") {
    setRoutineCreateOpen(false);
    setOkrChatContext({
      key: `${currentWorkspace?.id ?? "workspace"}:routine`,
      entry: "routine",
      cycleId: "",
      cycleName: "Routine",
      initialMessage: initialMessage.trim(),
      target: null,
      targetCandidates: [],
    });
    setSelectedProjectId(null);
    setSelectedTaskId(null);
    setActiveView("home");
    writeNavigation("home", null, null);
  }

  async function createTasksFromConversation(taskText: string, containerValue: string, assigneeMemberId: string | null) {
    const titles = taskText.split("\n").map((entry) => entry.trim()).filter(Boolean);
    const [containerKind, containerId] = containerValue.split(":", 2);
    const container = containerValue ? taskContainerOptions.find((entry) => entry.kind === containerKind && entry.id === containerId) : null;
    const project = containerKind === "project" ? executionItems.find((entry) => entry.id === containerId) : null;
    if (!titles.length || (containerValue && (!container || containerKind !== "project" && containerKind !== "routine"))) return false;
    try {
      const response = await fetch("/api/items", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          titles,
          kind: "task",
          cycleId: container?.kind === "project" ? project?.cycleId ?? null : null,
          parentId: container?.kind === "project" ? container.id : null,
          routineId: container?.kind === "routine" ? container.id : null,
          source: "web",
          assigneeMemberId,
        }),
      });
      const data = await response.json().catch(() => ({})) as { items?: OkriItem[]; error?: string };
      if (!response.ok || !data.items) throw new Error(apiError(data, "Task를 만들지 못했습니다."));
      const created = data.items;
      setItems((current) => [...current, ...created]);
      setOkrChatContext(null);
      navigateView("inbox");
      showNotice(container ? t("Task {value1}개를 연결해 만들었습니다.", { value1: messageValue(created.length) }) : t("Task {value1}개를 General에 만들었습니다.", { value1: messageValue(created.length) }));
      return true;
    } catch (error) {
      showNotice(error instanceof Error ? error.message : t("Task를 만들지 못했습니다."), "error");
      return false;
    }
  }

  function openProjectPage(id: string) {
    setSelectedTaskId(null);
    setSelectedProjectId(id);
    setActiveView("work");
    writeNavigation("work", id, null);
  }

  function addCreatedItem(created: OkriItem, initialValues: Record<string, PropertyValue> = {}, warning?: string) {
    setItems((current) => [...current, created]);
    if (Object.keys(initialValues).length) {
      setPropertyValues((current) => ({ ...current, [created.id]: { ...current[created.id], ...initialValues } }));
    }
    setCreateItemOpen(false);
    showNotice(warning ?? t("{value1}를 만들었습니다.", { value1: messageValue(kindLabel(created.kind)) }), warning ? "error" : "success");
  }

  function createOkrFile() {
    if (okrEditorDirty) {
      void confirmAction({ title: t("새 OKR 파일"), message: t("저장하지 않은 변경사항을 버리고 새 OKR 파일을 만들까요?"), confirmLabel: t("변경사항 버리기"), danger: true }).then((confirmed) => {
        if (!confirmed) return;
        setOkrListOpen(false);
        setOkrEditorDirty(false);
        setOkrCreating(true);
        setActiveView("okr");
        writeNavigation("okr", null, null);
      });
      return;
    }
    setOkrListOpen(false);
    setOkrCreating(true);
    setActiveView("okr");
    writeNavigation("okr", null, null);
  }

  function selectOkrFile(id: string) {
    if (okrEditorDirty) {
      void confirmAction({ title: t("다른 OKR 파일 열기"), message: t("저장하지 않은 변경사항을 버리고 다른 OKR 파일을 열까요?"), confirmLabel: t("변경사항 버리기"), danger: true }).then((confirmed) => {
        if (!confirmed) return;
        setOkrCreating(false);
        setOkrEditorDirty(false);
        setSelectedOkrCycleId(id);
        setVisibleOkrCycleIds([id]);
        setOkrListOpen(false);
      });
      return;
    }
    setOkrCreating(false);
    setOkrEditorDirty(false);
    setSelectedOkrCycleId(id);
    setVisibleOkrCycleIds([id]);
    setOkrListOpen(false);
  }

  function applySavedOkrFile(file: { cycle: OkrFileCycleSummary }) {
    setOkrCreating(false);
    setOkrEditorDirty(false);
    setSelectedOkrCycleId(file.cycle.id);
    setVisibleOkrCycleIds([file.cycle.id]);
    setOkrCycles((current) => {
      const found = current.some((cycle) => cycle.id === file.cycle.id);
      const merged = found ? current.map((cycle) => cycle.id === file.cycle.id ? file.cycle : cycle) : [file.cycle, ...current];
      return merged.map((cycle) => ({ ...cycle, status: file.cycle.status === "active" && cycle.id !== file.cycle.id && cycle.status === "active" ? "planned" : cycle.status }));
    });
    clearCachedBootstrap();
    setWorkspaceDataAttempt((current) => current + 1);
  }

  async function setDefaultOkrFile(id: string) {
    const previous = okrCycles;
    setOkrCycles((current) => current.map((cycle) => ({ ...cycle, status: cycle.id === id ? "active" : cycle.status === "active" ? "planned" : cycle.status })));
    setSelectedOkrCycleId(id);
    setVisibleOkrCycleIds((current) => current.includes(id) ? current : [id, ...current]);
    try {
      const response = await fetch("/api/okr-cycles", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id, status: "active" }),
      });
      if (!response.ok) throw new Error("cycle");
      const data = await response.json() as { cycle: OkrCycle };
      setOkrCycles((current) => current.map((cycle) => ({ ...cycle, status: cycle.id === data.cycle.id ? data.cycle.status : cycle.status === "active" ? "planned" : cycle.status })));
      showNotice(t("기본으로 열 OKR 파일을 바꿨습니다."));
    } catch {
      setOkrCycles(previous);
      showNotice(t("기본 OKR 파일을 바꾸지 못했습니다."));
    }
  }

  async function deleteOkrFile(id: string) {
    const cycle = okrCycles.find((entry) => entry.id === id);
    if (!cycle) return;
    if (deletingOkrCycleIds.has(id)) return;
    if (okrCycles.length <= 1) {
      showNotice(t("OKR 파일은 최소 1개가 필요합니다."));
      return;
    }
    if (!await confirmAction({ title: t("OKR 파일 삭제"), message: t("'{value1}' 파일 연결만 해제합니다. 작업 항목 자체는 삭제하지 않습니다.", { value1: messageValue(cycle.name) }), confirmLabel: t("파일 삭제"), danger: true })) return;
    setDeletingOkrCycleIds((current) => new Set(current).add(id));
    const slowTimer = window.setTimeout(() => setSlowDeletingOkrCycleId(id), 800);
    try {
      const response = await fetch(`/api/okr-cycles?id=${encodeURIComponent(id)}`, { method: "DELETE" });
      if (!response.ok) throw new Error("cycle");
      const data = await response.json() as { deletedId: string; nextActiveId: string | null };
      const remaining = okrCycles.filter((entry) => entry.id !== data.deletedId);
      const nextSelectedId = data.nextActiveId ?? remaining[0]?.id ?? null;
      setOkrCycles(remaining.map((entry) => ({ ...entry, status: entry.id === data.nextActiveId ? "active" : entry.status === "active" && cycle.status === "active" ? "planned" : entry.status })));
      if (selectedOkrCycle?.id === id) setSelectedOkrCycleId(nextSelectedId);
      setVisibleOkrCycleIds((current) => current.filter((entry) => entry !== id));
      setItems((current) => current.map((entry) => entry.cycleId === id ? { ...entry, cycleId: null } : entry));
      showNotice(t("OKR 파일을 삭제했습니다."));
    } catch {
      showNotice(t("OKR 파일을 삭제하지 못했습니다."));
    } finally {
      window.clearTimeout(slowTimer);
      setSlowDeletingOkrCycleId((current) => current === id ? null : current);
      setDeletingOkrCycleIds((current) => {
        const next = new Set(current);
        next.delete(id);
        return next;
      });
    }
  }

  async function createOnboardingPlan(plan: OnboardingPlan, targetCycleId: string | null = selectedOkrCycle?.id ?? null) {
    const objectiveTitle = plan.objectiveTitle.trim();
    if (!objectiveTitle) {
      showNotice(t("Objective 이름을 먼저 적어 주세요."));
      return null;
    }
    if (!plan.keyResults.length || plan.keyResults.some((entry) => !entry.title.trim())) {
      showNotice(t("Objective에는 하나 이상의 Key Result가 필요합니다."));
      return null;
    }
    if (!targetCycleId) {
      showNotice(t("OKR 주기를 먼저 선택해 주세요."));
      return null;
    }
    if (plan.keyResults.some((entry) => entry.initiatives.some((initiative) => !initiative.title.trim()))) {
      showNotice(t("비어 있는 Initiative 이름을 입력하거나 제거해 주세요."));
      return null;
    }
    if (plan.unassignedInitiatives.length) {
      showNotice(t("KR 미지정 Initiative의 연결 대상을 먼저 선택해 주세요."));
      return null;
    }
    try {
      const okrResult = await applyAssistantOkrPlan(plan, targetCycleId, null, null);
      if (!okrResult) return null;
      if (workspaceRules) {
        const response = await fetch("/api/workspace-rules", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ ...workspaceRules, configured: true }),
        });
        if (response.ok) {
          const data = await response.json() as { rules: WorkspaceRules };
          setWorkspaceRules(data.rules);
        }
      }
      return {
        cycleId: targetCycleId,
        items: okrResult.items,
        keyResultIds: okrResult.keyResultIds,
        initiativeIds: okrResult.initiativeIds,
        projectIds: okrResult.projectIds,
      } satisfies PlanCreationResult;
    } catch {
      showNotice(t("OKR 구성을 만들지 못했습니다."));
      return null;
    }
  }

  async function applyAssistantOkrPlan(plan: OnboardingPlan, cycleId: string, target: OkrPlanTarget | null, _driMemberId: string | null) {
    void _driMemberId;
    try {
      const response = await fetch("/api/okr-plan", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          cycleId,
          targetId: target?.id ?? null,
          targetKind: target?.kind ?? null,
          tree: {
            objectiveTitle: plan.objectiveTitle,
            keyResults: plan.keyResults.map((keyResult) => ({
              title: keyResult.title,
              initiatives: keyResult.initiatives.map((initiative) => ({ title: initiative.title })),
            })),
            targetInitiatives: plan.targetInitiatives.map((initiative) => ({ title: initiative.title })),
          },
          project: "",
          driMemberId: null,
        }),
      });
      const data = await response.json() as OkrPlanApplyResult & { error?: string };
      if (!response.ok) throw new Error(apiError(data, "apply failed"));
      setItems((current) => {
        const createdIds = new Set(data.items.map((entry) => entry.id));
        return [...current.filter((entry) => !createdIds.has(entry.id)), ...data.items];
      });
      setWorkspaceRules((current) => current ? { ...current, configured: true } : current);
      setSelectedOkrCycleId(data.cycleId);
      setVisibleOkrCycleIds((current) => current.includes(data.cycleId) ? current : [data.cycleId, ...current]);
      const krCount = data.keyResultIds?.length ?? 0;
      const initiativeCount = data.initiativeIds?.length ?? 0;
      showNotice(t("KR {value1}개 · Initiative {value2}개를 만들었습니다. 실행 계획은 Project 탭에서 만들 수 있습니다.", { value1: messageValue(krCount), value2: messageValue(initiativeCount) }));
      return data;
    } catch {
      showNotice(t("OKR 구성을 만들지 못했습니다."));
      return null;
    }
  }

  async function createProjectFromConversation(plan: OnboardingPlan, target: ProjectChatTarget, driMemberId: string | null) {
    const projectTitle = plan.project.trim();
    if (!projectTitle) {
      showNotice(t("Project 이름을 먼저 정리해 주세요."));
      return false;
    }
    try {
      const projectResponse = await fetch("/api/items", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: projectTitle,
          kind: "project",
          cycleId: target.cycleId,
          parentId: target.initiativeId,
          status: "in_progress",
          driMemberId: driMemberId || currentTeamMember?.id || null,
        }),
      });
      const projectData = await projectResponse.json().catch(() => ({})) as { item?: OkriItem; error?: string; messageCode?: string };
      if (!projectResponse.ok || !projectData.item) throw new Error(apiError(projectData, "Project를 만들지 못했습니다."));
      const projectItem = projectData.item;
      const taskTitles = plan.tasks.split("\n").map((entry) => entry.trim()).filter(Boolean);
      let createdTasks: OkriItem[] = [];
      if (taskTitles.length) {
        const taskResponse = await fetch("/api/items", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            titles: taskTitles,
            kind: "task",
            parentId: projectItem.id,
          }),
        });
        const taskData = await taskResponse.json().catch(() => ({})) as { items?: OkriItem[]; error?: string };
        if (!taskResponse.ok || !taskData.items) {
          setItems((current) => [...current, projectItem]);
          setOkrChatContext(null);
          setSelectedProjectId(null);
          setSelectedTaskId(null);
          if (target.cycleId) {
            setSelectedOkrCycleId(target.cycleId);
            setVisibleOkrCycleIds((current) => current.includes(target.cycleId!) ? current : [target.cycleId!, ...current]);
          }
          navigateView("work");
          showNotice(t("Project는 만들었지만 하위 Task는 저장하지 못했습니다. Project에서 다시 추가해 주세요."), "error");
          return true;
        }
        createdTasks = taskData.items;
      }
      setItems((current) => [...current, projectItem, ...createdTasks]);
      setOkrChatContext(null);
      setSelectedProjectId(null);
      setSelectedTaskId(null);
      if (target.cycleId) {
        setSelectedOkrCycleId(target.cycleId);
        setVisibleOkrCycleIds((current) => current.includes(target.cycleId!) ? current : [target.cycleId!, ...current]);
      }
      navigateView("work");
      showNotice(createdTasks.length ? t("Project와 하위 Task {value1}개를 만들었습니다.", { value1: messageValue(createdTasks.length) }) : t("Project를 만들었습니다."));
      return true;
    } catch (error) {
      showNotice(error instanceof Error ? error.message : t("Project를 만들지 못했습니다."), "error");
      return false;
    }
  }

  async function createRoutineFromConversation(plan: OnboardingPlan, assigneeMemberId: string | null) {
    const routineTitle = plan.routineTitle.trim();
    if (!routineTitle) {
      showNotice(t("Routine 이름을 먼저 정리해 주세요."));
      return false;
    }
    try {
      const response = await fetch("/api/routines", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: routineTitle,
          triggerPoint: plan.routineTrigger,
          actionPlace: plan.routinePlace,
          actionSteps: plan.routineSteps,
          cadence: plan.routineCadence,
          assigneeMemberId,
        }),
      });
      const data = await response.json().catch(() => ({})) as { routine?: Routine; error?: string };
      if (!response.ok || !data.routine) throw new Error(apiError(data, "Routine을 만들지 못했습니다."));
      const routine = data.routine;
      setRoutines((current) => [...current, routine]);
      const taskTitles = plan.tasks.split("\n").map((entry) => entry.trim()).filter(Boolean);
      let createdTasks: OkriItem[] = [];
      if (taskTitles.length) {
        const taskResponse = await fetch("/api/items", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            titles: taskTitles,
            kind: "task",
            routineId: routine.id,
          }),
        });
        const taskData = await taskResponse.json().catch(() => ({})) as { items?: OkriItem[]; error?: string };
        if (!taskResponse.ok || !taskData.items) {
          setOkrChatContext(null);
          navigateView("routines");
          showNotice(t("Routine은 만들었지만 하위 Task는 저장하지 못했습니다. Routine에서 다시 추가해 주세요."), "error");
          return true;
        }
        createdTasks = taskData.items;
        setItems((current) => [...current, ...createdTasks]);
      }
      setOkrChatContext(null);
      navigateView("routines");
      showNotice(createdTasks.length ? t("Routine과 하위 Task {value1}개를 만들었습니다.", { value1: messageValue(createdTasks.length) }) : t("Routine을 만들었습니다."));
      return true;
    } catch (error) {
      showNotice(error instanceof Error ? error.message : t("Routine을 만들지 못했습니다."), "error");
      return false;
    }
  }

  if (authState.status === "loading") return <AppLoadingScreen />;
  if (authState.status === "unauthenticated") return <LandingScreen reason={authState.reason} onSignIn={startGoogleSignIn} />;
  const languageRecovery = languageFailure && <LanguageLoadError language={languageFailure.preferences.resolvedLanguage} onRetry={async () => {
    await applyAccountLanguage(languageFailure.userId, languageFailure.preferences);
    setLanguageFailure(null);
  }} />;
  if (languageFailure && language.userId !== authState.user?.id) return <main className="app-loading-screen">{languageRecovery}</main>;
  return (
    <main className="app-shell">
      <aside className="sidebar">
        <div className="workspace-control">
          <button
            className="workspace-switcher"
            onClick={() => {
              setWorkspaceMenuOpen((open) => {
                const nextOpen = !open;
                if (!nextOpen) {
                  setWorkspaceCreateOpen(false);
                  setNewWorkspaceName("");
                }
                return nextOpen;
              });
            }}
            aria-expanded={workspaceMenuOpen}
            aria-haspopup="menu"
          >
            <WorkspaceAvatar workspace={currentWorkspace} className="brand-mark" />
            <span><strong>{currentWorkspace?.name || t("개인 워크스페이스")}</strong></span>
            <ChevronDown size={14} />
          </button>
          <button className="workspace-settings-trigger" onClick={() => openWorkspaceSettings("general")} aria-label={t("워크스페이스 설정")} title={t("워크스페이스 설정")}><Settings size={17} /></button>
          {workspaceMenuOpen && (
            <div className="workspace-menu" role="menu" aria-label={t("워크스페이스 선택")}>
              <header><b>{t("워크스페이스")}</b><span>{activeWorkspaces.length}</span></header>
              <div className="workspace-list">
                {activeWorkspaces.map((workspace) => (
                  <div className="workspace-row" key={workspace.id}>
                    <button onClick={() => void switchWorkspace(workspace.id)} disabled={workspaceSaving}>
                      <WorkspaceAvatar workspace={workspace} />
                      <span><b>{workspace.name}</b><small>{workspace.personal ? t("개인") : `${t("팀")} · ${teamRoleLabel(workspace.role)}`}{(workspaceNameCounts.get(workspace.name.trim().toLocaleLowerCase()) ?? 0) > 1 ? t(" · 생성 {value1}", { value1: messageValue(formatDateTime(workspace.createdAt)) }) : ""}</small></span>
                      {workspace.current && <Check size={14} />}
                    </button>
                  </div>
                ))}
              </div>
              <div className="workspace-create">
                {workspaceCreateOpen ? (
                  <form className="workspace-create-form" onSubmit={createWorkspace}>
                    <input
                      value={newWorkspaceName}
                      onChange={(event) => setNewWorkspaceName(event.target.value)}
                      placeholder={t("팀 워크스페이스 이름")}
                      aria-label={t("팀 워크스페이스 이름")}
                      maxLength={80}
                      ref={workspaceNameInputRef}
                    />
                    <button disabled={!newWorkspaceName.trim() || workspaceSaving} aria-label={t("워크스페이스 만들기")} title={t("워크스페이스 만들기")}><Check size={14} /></button>
                    <button
                      type="button"
                      onClick={() => {
                        setWorkspaceCreateOpen(false);
                        setNewWorkspaceName("");
                      }}
                      aria-label={t("취소")}
                      title={t("취소")}
                    >
                      <X size={14} />
                    </button>
                  </form>
                ) : (
                  <button className="workspace-create-trigger" onClick={() => setWorkspaceCreateOpen(true)}>
                    <Plus size={14} />
                    <span>{t("새 팀 워크스페이스")}</span>
                  </button>
                )}
              </div>
            </div>
          )}
        </div>
        <nav className="desktop-navigation">
          {navItems.map((entry) => {
            const Icon = entry.icon;
            return (
              <button className={`nav-item ${activeView === entry.id && !selectedProject ? "active" : ""}`} aria-current={activeView === entry.id && !selectedProject && !selectedTask ? "page" : undefined} key={entry.id} onClick={() => entry.id === "home" ? openAssistant() : navigateView(entry.id)}>
                <Icon size={16} /><span>{entry.label}</span>
              </button>
            );
          })}
        </nav>
        <nav className="mobile-navigation" aria-label={t("주요 메뉴")}>
          {mobileNavItems.map((entry) => {
            const Icon = entry.icon;
            return (
              <button className={`nav-item ${activeView === entry.id && !selectedProject ? "active" : ""}`} aria-current={activeView === entry.id && !selectedProject && !selectedTask ? "page" : undefined} key={entry.id} onClick={() => entry.id === "home" ? openAssistant() : navigateView(entry.id)}>
                <Icon size={16} /><span>{entry.label}</span>
              </button>
            );
          })}
          <button className={`nav-item ${mobileMenuOpen ? "active" : ""}`} onClick={() => setMobileMenuOpen(true)}><Menu size={16} /><span>{t("더보기")}</span></button>
        </nav>
        <div className="sidebar-bottom">
          <AppInstallButton />
          <button className="nav-item" onClick={() => setIntegrationOpen(true)}><Link2 size={16} /><span>{t("AI 연결")}</span></button>
          <button className={`nav-item ${activeView === "integrations" && !selectedProject && !selectedTask ? "active" : ""}`} aria-current={activeView === "integrations" && !selectedProject && !selectedTask ? "page" : undefined} onClick={() => navigateView("integrations")}><Plug size={16} /><span>{t("개인 앱 연동")}</span></button>
          <button className={`nav-item ${activeView === "billing" && !selectedProject && !selectedTask ? "active" : ""}`} aria-current={activeView === "billing" && !selectedProject && !selectedTask ? "page" : undefined} onClick={() => navigateView("billing")}><CreditCard size={16} /><span>{t("요금제 및 결제")}</span></button>
          <button className="profile-row" onClick={() => setPropertyPanelOpen(true)}><span className="avatar">{accountInitial}</span><span>{accountDisplayName}</span><MoreHorizontal size={15} /></button>
        </div>
      </aside>

      {mobileMenuOpen && (
        <OverlayDialog title={t("더보기 메뉴")} variant="sheet" className="mobile-menu-backdrop" onRequestClose={() => setMobileMenuOpen(false)}>
          {(requestClose) => <aside className="mobile-menu-sheet">
            <header><div><b>{currentWorkspace?.name || t("개인 워크스페이스")}</b><small>{currentWorkspace?.personal ? t("개인 워크스페이스") : t("팀 워크스페이스")}</small></div><span className="mobile-menu-header-actions"><button className="icon-button" onClick={() => openWorkspaceSettings("general")} aria-label={t("워크스페이스 설정")}><Settings size={17} /></button><button className="icon-button" onClick={() => requestClose("close-button")} aria-label={t("닫기")}><X size={17} /></button></span></header>
            <div className="mobile-menu-list">
              <AppInstallButton />
              {mobileMoreItems.map((entry) => { const Icon = entry.icon; return <button key={entry.id} onClick={() => { navigateView(entry.id); setMobileMenuOpen(false); }}><Icon size={16} /><span>{entry.label}</span><ChevronRight size={14} /></button>; })}
              <button onClick={() => { setMobileMenuOpen(false); setIntegrationOpen(true); }}><Link2 size={16} /><span>{t("AI 연결")}</span><ChevronRight size={14} /></button>
              <button onClick={() => { setMobileMenuOpen(false); navigateView("integrations"); }}><Plug size={16} /><span>{t("개인 앱 연동")}</span><ChevronRight size={14} /></button>
              <button onClick={() => { setMobileMenuOpen(false); navigateView("billing"); }}><CreditCard size={16} /><span>{t("요금제 및 결제")}</span><ChevronRight size={14} /></button>
              <button className="mobile-account-entry" onClick={() => { setMobileMenuOpen(false); setPropertyPanelOpen(true); }}><span className="avatar">{accountInitial}</span><span><b>{accountDisplayName}</b><small>{t("개인 설정")}</small></span><ChevronRight size={14} /></button>
            </div>
          </aside>}
        </OverlayDialog>
      )}

      <section className="workspace">
        <header className="workspace-topbar">
          <button
            type="button"
            className="workspace-brand"
            onClick={() => navigateView("okr")}
            aria-label={t("홈으로 이동")}
            aria-current={activeView === "okr" && !selectedProject && !selectedTask ? "page" : undefined}
          >
            <House size={18} />
          </button>
          <button
            type="button"
            className="workspace-mobile-home"
            onClick={goToMobileHome}
            aria-label={t("홈으로 이동")}
            aria-current={activeView === "okr" && !selectedProject && !selectedTask ? "page" : undefined}
          >
            <House size={18} /><span>{t("홈")}</span>
          </button>
          <button type="button" className="workspace-search-trigger" onClick={openSearch} aria-label={t("업무 또는 메뉴 검색")} aria-haspopup="dialog"><Search size={16} /><span>{t("업무 또는 메뉴 검색…")}</span><kbd>{typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform) ? "⌘ K" : "Ctrl K"}</kbd></button>
          <div className="workspace-topbar-actions"><button className="mobile-assistant-trigger" aria-label={t("AI 대화 열기")} title={t("AI 대화 열기")} onClick={openAssistant}><span aria-hidden="true">🤖</span></button><button className="workspace-topbar-settings" aria-label={t("워크스페이스 설정")} title={t("워크스페이스 설정")} onClick={() => openWorkspaceSettings("general")}><Settings size={16} /></button><button aria-label={t("서비스 안내")} title={t("서비스 안내")} onClick={() => setOnboardingOpen(true)}><CircleHelp size={15} /></button></div>
        </header>
        <div className="page-body">
          {languageRecovery}
          {!setupOpen && authState.user?.onboarding?.status !== "active" && <MarketingConsentPrompt
            key={authState.user?.id ?? ""}
            userId={authState.user?.id ?? ""}
            onNotice={(message) => showNotice(message, "error")}
          />}
          {!setupOpen && authState.user?.onboarding && authState.user.onboarding.status !== "completed" && <button type="button" onClick={() => setSetupOpen(true)}>{t("처음 설정 이어하기")}<ChevronRight size={14} /></button>}
          {activeView !== "home" && !selectedProject && <header className="page-header">
            <div><h1>{viewTitles[activeView]}</h1>{activeView !== "okr" && <p>{activeView === "billing" ? `${currentWorkspace?.name ?? ""} · ${pageSubtitle(activeView)}` : pageSubtitle(activeView)}</p>}</div>
            {activeView === "okr" ? (
              <button className="primary-action" onClick={() => setOkrListOpen(true)}><Archive size={14} />{t("목록보기")}</button>
            ) : activeView === "inbox" ? (
              <div className="page-create-actions"><button onClick={() => openTaskCreationChat()}><Bot size={14} />{t("AI 대화로 추가")}</button><button className="primary-action" onClick={() => openCreateItem("task", null)}><Plus size={14} />{t("직접 추가")}</button></div>
            ) : activeView === "work" ? (
              <div className="page-create-actions"><button onClick={() => openProjectCreationChat()}><Bot size={14} />{t("AI 대화로 추가")}</button><button className="primary-action" onClick={() => openCreateItem("project")}><Plus size={14} />{t("직접 추가")}</button></div>
            ) : activeView === "routines" ? (
              <div className="page-create-actions"><button onClick={() => openRoutineCreationChat()}><Bot size={14} />{t("AI 대화로 추가")}</button><button className="primary-action" onClick={() => setRoutineCreateOpen(true)}><Plus size={14} />{t("직접 추가")}</button></div>
            ) : activeView === "reviews" ? (
              <CadenceSwitch value={cadence} onChange={setCadence} />
            ) : null}
          </header>}

          {workspaceDataState === "error" ? (
            <AsyncState
              icon={AlertTriangle}
              title={t("워크스페이스 데이터를 불러오지 못했습니다")}
              detail={t("연결을 확인한 뒤 다시 시도해 주세요. 입력한 내용은 변경되지 않았습니다.")}
              actionLabel={t("다시 시도")}
              onAction={() => { setWorkspaceDataState("loading"); setWorkspaceDataAttempt((attempt) => attempt + 1); }}
            />
          ) : workspaceDataState === "loading" ? (
            <AsyncState icon={LoaderCircle} title={t("{value1} 데이터를 불러오는 중입니다", { value1: messageValue(viewTitles[activeView]) })} loading />
          ) : <>
          <div className="assistant-view-shell" hidden={activeView !== "home" || Boolean(selectedProject)}>
            <HomeView
              key={okrChatContext?.key ?? `${currentWorkspace?.id ?? "workspace"}:default`}
              onCreatePlan={createOnboardingPlan}
              onCreateProject={createProjectFromConversation}
              onCreateRoutine={createRoutineFromConversation}
              onApplyOkrPlan={applyAssistantOkrPlan}
              onCreateTasks={createTasksFromConversation}
              onStartTaskCreation={openTaskCreationChat}
              onFinish={() => { const destination = okrChatContext?.entry === "task" ? "inbox" : okrChatContext?.entry === "project" ? "work" : okrChatContext?.entry === "routine" ? "routines" : "okr"; setOkrChatContext(null); navigateView(destination); }}
              onNavigateToOkr={() => { setOkrChatContext(null); navigateView("okr"); }}
              context={okrChatContext}
              usageScope={activeView === "home" && currentWorkspace && authState.user ? { workspaceId: currentWorkspace.id, userId: authState.user.id } : null}
              workspaceContext={assistantWorkspaceContext}
              canWrite={canWriteWorkspace}
              members={teamMembers.filter((member) => member.status === "active")}
              taskContainers={taskContainerOptions}
              projectTargets={projectChatTargets}
              defaultDriMemberId={currentTeamMember?.id ?? null}
              defaultCycleId={selectedOkrCycle?.id ?? null}
            />
          </div>

          {selectedProject ? (
            <ProjectPageView
              key={selectedProject.id}
              project={selectedProject}
              allItems={items}
              properties={properties}
              propertyValues={propertyValues}
              hiddenPropertyIds={hiddenProperties[selectedProject.id] ?? []}
              teamMembers={teamMembers}
              onClose={closeDetail}
              onBackToList={() => navigateView("work")}
              onPatch={patchItem}
              onPropertyChange={setPropertyValue}
              onPropertyVisibility={(propertyId, hidden) => void setProjectPropertyVisibility(selectedProject.id, propertyId, hidden)}
              onAssignmentsChange={updateItemAssignments}
              onTaskCreated={(created) => setItems((current) => [...current, created])}
              onItemsRefresh={(freshItems) => setItems((current) => [...current.filter((entry) => !freshItems.some((fresh) => fresh.id === entry.id)), ...freshItems])}
              onOpenTask={openTaskDetail}
              readOnly={currentWorkspace?.role === "viewer"}
              onNotice={showNotice}
              onArchive={() => void archiveProjectItem(selectedProject)}
              canDeleteItem={(item) => deletableItemIds.has(item.id)}
              selectedItemIds={selectedDeleteItemIds}
              onToggleSelect={toggleDeleteSelection}
            />
          ) : (
            <>
          {activeView === "my_work" && <MyWorkView key={`${currentWorkspace?.id ?? ""}:${currentTeamMember?.id ?? ""}`} workspaceId={currentWorkspace?.id ?? ""} items={activeItems} routines={routines} currentMember={currentTeamMember ?? null} onOpenProject={openProjectPage} onOpenTask={openTaskDetail} onRoutinesChange={setRoutines} onNotice={showNotice} />}
          {activeView === "inbox" && <TaskListView items={taskItems} allItems={items} routines={routines} onOpenTask={openTaskDetail} onPatch={patchItem} canDeleteItem={(item) => deletableItemIds.has(item.id)} selectedItemIds={selectedDeleteItemIds} onToggleSelect={toggleDeleteSelection} onSelectItems={addDeleteItems} onClearItems={removeDeleteItems} onTrashSelected={() => void moveSelectedItemsToTrash()} trashing={trashingItems} />}
          {activeView === "work" && (
            <section className="project-workspace">
              <TaskDatabase
                items={executionItems}
                allItems={activeItems}
                properties={properties}
                values={propertyValues}
                hiddenProperties={hiddenProperties}
                display={taskDisplay}
                onDisplayChange={setTaskDisplay}
                onPatch={patchItem}
                onPropertyChange={setPropertyValue}
                onOpenProperties={() => openWorkspaceSettings("projects")}
                onOpenTask={openTaskDetail}
                onOpenProject={openProjectPage}
                canDeleteItem={(item) => deletableItemIds.has(item.id)}
                selectedItemIds={selectedDeleteItemIds}
                onToggleSelect={toggleDeleteSelection}
                onSelectItems={addDeleteItems}
                onClearItems={removeDeleteItems}
              />
            </section>
          )}
          {activeView === "gantt" && <GanttView items={activeItems} onOpenProject={openProjectPage} onOpenTask={openTaskDetail} />}
          {activeView === "routines" && <RoutineView key={`${currentWorkspace?.id}:${searchNavigationId}`} focusId={searchFocusId} onDirtyChange={setRoutineEditorDirty} workspaceId={currentWorkspace?.id ?? ""} readOnly={!canWriteWorkspace} canManageProperties={currentWorkspace?.role === "owner" || currentWorkspace?.role === "admin"} initialRoutines={routines} teamMembers={teamMembers} onNotice={showNotice} onRoutinesChange={setRoutines} createOpen={routineCreateOpen} onCreateClose={() => setRoutineCreateOpen(false)} onCreateWithChat={openRoutineCreationChat} />}
          {activeView === "data" && <ClientDataView key={currentWorkspace?.id ?? ""} cacheKey={currentWorkspace?.id ?? ""} items={activeItems} cycles={okrCycles} readOnly={currentWorkspace?.role === "viewer"} onProgressChange={(id, progress) => setItems((current) => current.map((entry) => entry.id === id ? { ...entry, progress } : entry))} onNotice={showNotice} />}
          {activeView === "okr" && (
            <section className="okr-workbench">
              <section className="okr-document">
                {okrCreating || selectedOkrCycle ? <OkrFileSurface
                  focusId={searchFocusId}
                  key={`${currentWorkspace?.id ?? ""}:${okrCreating ? "new" : selectedOkrCycle?.id}:${searchNavigationId}`}
                  workspaceId={currentWorkspace?.id ?? ""}
                  cycle={okrCreating ? null : selectedOkrCycle ?? null}
                  creating={okrCreating}
                  readOnly={!canWriteWorkspace}
                  executionItems={activeItems}
                  onSaved={applySavedOkrFile}
                  onSplit={(cycles) => {
                    setOkrCycles(cycles);
                    clearCachedBootstrap();
                    setWorkspaceDataAttempt((current) => current + 1);
                  }}
                  onCancelCreate={() => { setOkrCreating(false); setOkrEditorDirty(false); }}
                  onOpenProject={openProjectPage}
                  onOpenTask={openTaskDetail}
                  onNotice={(message, tone) => showNotice(message, tone)}
                  onDirtyChange={setOkrEditorDirty}
                  onConfirm={(options) => confirmAction(options)}
                /> : <div className="okr-file-empty"><Archive size={22} /><div><h2>{t("OKR 파일이 없습니다")}</h2><p>{t("Objective·KR·Initiative를 한 번에 작성해 첫 파일을 만드세요.")}</p></div>{canWriteWorkspace && <button onClick={createOkrFile}><Plus size={14} />{t("새 OKR 파일")}</button>}</div>}
              </section>
            </section>
          )}
          {activeView === "scrum" && <DailyScrumView workspaceId={currentWorkspace?.id ?? ""} onOpenProject={openProjectPage} onNavigate={navigateView} onOpenTask={openTaskDetail} onNotice={showNotice} />}
          {activeView === "integrations" && <AppIntegrationsView google={googleStatus} slack={slackStatus} loading={integrationStatusRefreshing || !integrationStatusesLoaded} loadError={integrationStatusError} onGoogleChange={setGoogleStatus} onRefresh={refreshIntegrationStatuses} onNotice={showNotice} />}
          {activeView === "billing" && <BillingView onNotice={showNotice} />}
          {activeView === "recommendations" && <RecommendationsView workspaceId={currentWorkspace?.id ?? ""} items={activeItems} onOpenTask={openTaskDetail} onOpenProject={openProjectPage} onNavigate={navigateView} />}
          {activeView === "reviews" && <ReviewView items={periodItems} cadence={cadence} completed={completed} blocked={blocked} averageProgress={averageProgress} onOpenTask={openTaskDetail} onOpenProject={openProjectPage} />}
          {activeView === "trash" && <TrashView workspaceId={currentWorkspace?.id ?? ""} onNotice={showNotice} canDeleteRecords={canDeleteRecords} canRestore={Boolean(currentWorkspace && currentWorkspace.role !== "viewer")} />}
            </>
          )}
          </>}
        </div>
      </section>

      {activeView !== "inbox" && selectedDeleteItemIds.size > 0 && (
        <div className="bulk-delete-bar" role="region" aria-label={t("선택 항목 작업")}>
          <b>{t("{count}개 선택", { count: selectedDeleteItemIds.size })}</b>
          <button onClick={() => setSelectedDeleteItemIds(new Set())}>{t("선택 해제")}</button>
          <button className="danger" disabled={trashingItems} onClick={() => void moveSelectedItemsToTrash()}><Trash2 size={14} />{trashingItems ? t("이동 중") : t("휴지통으로 이동")}</button>
        </div>
      )}
      {notice && <div className={`toast toast-${notice.tone}`} role={notice.tone === "error" ? "alert" : "status"} aria-live={notice.tone === "error" ? "assertive" : "polite"}><span>{notice.message}</span><button type="button" onClick={() => setNotice(null)} aria-label={t("알림 닫기")}><X size={13} /></button></div>}
      {okrListOpen && (
        <OverlayDialog title={t("OKR 파일 목록")} variant="drawer" onRequestClose={() => setOkrListOpen(false)}>
          {(requestClose) =>
          <OkrFileManager
            cycles={okrCycles}
            selectedCycle={selectedOkrCycle}
            itemCounts={okrCycleItemCounts}
            deletingIds={deletingOkrCycleIds}
            slowDeletingId={slowDeletingOkrCycleId}
            onSelect={selectOkrFile}
            onSetDefault={(id) => void setDefaultOkrFile(id)}
            onDelete={(id) => void deleteOkrFile(id)}
            onCreate={createOkrFile}
            onClose={() => requestClose("close-button")}
          />
          }
        </OverlayDialog>
      )}
      {onboardingOpen && (
        <WelcomeModal
          onSetup={() => { setOnboardingOpen(false); setSetupOpen(true); }}
          language={language.language}
          onLanguageChange={(choice) => {
            if (!authState.user) return;
            const userId = authState.user.id;
            void fetch("/api/account/preferences", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ language: choice, revision: language.preferences?.revision ?? 0 }) })
              .then(async (response) => { const data = await response.json() as { preferences?: LanguagePreferences }; if (!response.ok || !data.preferences) throw new Error("preference save failed"); await saveAccountLanguage(userId, data.preferences); })
              .catch(() => showNotice(t("언어를 저장하지 못했습니다. 다시 시도해 주세요."), "error"));
          }}
          onClose={() => {
            window.localStorage.setItem("okri.intro-seen", "1");
            setOnboardingOpen(false);
          }}
          onOpenMcp={() => {
            window.localStorage.setItem("okri.intro-seen", "1");
            setOnboardingOpen(false);
            setIntegrationOpen(true);
          }}
        />
      )}
      {setupOpen && authState.user && <FirstRunSetup
        key={authState.user.id}
        initial={authState.user.onboarding ?? null}
        workspaces={workspaces}
        onState={(onboarding) => setAuthState((current) => current.user && current.user.id === authState.user?.id ? { ...current, user: { ...current.user, onboarding } } : current)}
        onClose={() => setSetupOpen(false)}
        onFinish={async (onboarding, destination) => {
          if (onboarding.workspaceId) {
            const response = await fetch("/api/workspaces", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ workspaceId: onboarding.workspaceId }) });
            if (!response.ok) throw new Error("workspace_unavailable");
          }
          clearCachedBootstrap();
          const target = new URL(window.location.pathname, window.location.origin);
          const view = destination === "projects" ? "work" : destination === "work" ? "my_work" : destination === "members" || destination === "integrations" ? "okr" : destination;
          target.searchParams.set("view", view);
          if (destination === "members" || destination === "integrations") { target.searchParams.set("settings", "workspace"); target.searchParams.set("tab", destination); }
          window.location.assign(target.toString());
        }}
      />}
      {inviteToken && <InvitationDialog
        token={inviteToken}
        preview={invitePreview}
        loadError={inviteLoadError}
        onClose={() => {
          window.history.replaceState(window.history.state, "", `${window.location.pathname}${window.location.search}`);
          setInviteToken(null);
          setInvitePreview(null);
          setInviteLoadError("");
        }}
        onAccepted={() => {
          clearCachedBootstrap();
          window.history.replaceState(window.history.state, "", `${window.location.pathname}${window.location.search}`);
          window.location.reload();
        }}
      />}
      {profilePromptMember && (
        <ProfileNamePrompt
          key={profilePromptMember.id}
          member={profilePromptMember}
          onClose={() => setProfilePromptMember(null)}
          onSaved={(member) => {
            window.localStorage.setItem(profileNameConfirmationKey(member), member.displayName);
            setTeamData((current) => current ? { ...current, members: current.members.map((entry) => entry.id === member.id ? member : entry) } : current);
            setProfilePromptMember(null);
            showNotice(t("실명을 저장했습니다."));
          }}
        />
      )}
      {integrationOpen && <AIConnectionsDialog onNotice={showNotice} onClose={() => closePersonalDestination("ai")} />}
      {propertyPanelOpen && (
        <PropertyPanel
          user={authState.user}
          displayName={accountDisplayName}
          themeMode={themeMode}
          onThemeModeChange={setThemeMode}
          onClose={() => closePersonalDestination("personal")}
          onSignOut={() => { clearCachedBootstrap(); clearAccountLanguage(); window.location.href = "/api/auth/logout"; }}
        />
      )}
      {workspaceSettingsOpen && currentWorkspace && (
        <WorkspaceSettingsPanel
          key={currentWorkspace.id}
          currentWorkspace={currentWorkspace}
          scheduledWorkspaces={scheduledWorkspaces}
          teamData={teamData}
          properties={properties}
          teamMembers={teamMembers}
          tab={workspaceSettingsTab}
          requestedGroupHandle={requestedGroupHandle}
          slack={slackStatus}
          slackOAuthIssue={slackOAuthIssue}
          integrationLoading={integrationStatusRefreshing || !integrationStatusesLoaded}
          integrationLoadError={integrationStatusError}
          workspaceSaving={workspaceSaving}
          onTabChange={(tab) => openWorkspaceSettings(tab, "replace")}
          onClose={closeWorkspaceSettings}
          onIdentityChanged={(name) => {
            setWorkspaces((current) => current.map((entry) => entry.id === currentWorkspace.id ? { ...entry, name } : entry));
            setTeamData((current) => current?.workspace.id === currentWorkspace.id ? { ...current, workspace: { ...current.workspace, name } } : current);
            clearCachedBootstrap();
          }}
          onTeamChange={setTeamData}
          onPropertiesChanged={setProperties}
          onOpenAvatar={() => setWorkspaceAvatarOpen(true)}
          onCleanup={() => { closeWorkspaceSettings(); setCleanupOpen(true); }}
          onDeleteWorkspace={(workspace) => void deleteWorkspace(workspace)}
          onRestoreWorkspace={(workspace) => void restoreWorkspace(workspace)}
          onPermanentlyDeleteWorkspace={(workspace) => void permanentlyDeleteWorkspace(workspace)}
          onSlackChange={setSlackStatus}
          onRefreshIntegrations={refreshIntegrationStatuses}
          onNotice={showNotice}
        />
      )}
      {workspaceAvatarOpen && currentWorkspace && (
        <WorkspaceAvatarDialog
          workspace={currentWorkspace}
          onClose={() => setWorkspaceAvatarOpen(false)}
          onChanged={(avatarUrl, avatarUpdatedAt) => {
            setWorkspaces((current) => current.map((workspace) => workspace.id === currentWorkspace.id ? { ...workspace, avatarUrl, avatarUpdatedAt } : workspace));
            setTeamData((current) => current ? { ...current, workspace: { ...current.workspace, avatarUrl, avatarUpdatedAt } } : current);
            clearCachedBootstrap();
          }}
          onNotice={showNotice}
        />
      )}
      {createItemOpen && <CreateItemPanel initialKind={createItemKind} cycleId={createItemCycle?.id ?? null} items={items} routines={routines} properties={properties} teamMembers={teamMembers} onClose={() => setCreateItemOpen(false)} onCreated={addCreatedItem} onCreateWithChat={activeView === "inbox" && createItemKind === "task" ? ({ title }) => openTaskCreationChat(title) : activeView === "work" && createItemKind === "project" ? ({ title }) => openProjectCreationChat(title) : activeView === "okr" && createItemCycle ? ({ kind, title }) => openOkrCreationChat(createItemCycle, kind, title) : undefined} />}
      {cleanupOpen && <CleanupModal onClose={() => setCleanupOpen(false)} onCleaned={(cycle) => { setItems([]); setPropertyValues({}); setOkrCycles([cycle]); setVisibleOkrCycleIds([cycle.id]); setSelectedTaskId(null); navigateView("trash"); setCleanupOpen(false); showNotice(t("OKR 데이터를 휴지통에 보관하고 정리했습니다.")); }} onNotice={showNotice} />}
      {selectedTask && (
        <TaskDetailPanel
          task={selectedTask}
          readOnly={!canWriteWorkspace}
          allItems={activeItems}
          routines={routines}
          teamMembers={teamMembers}
          onClose={closeDetail}
          onOpenParent={(kind, id) => {
            if (kind === "project") openProjectPage(id);
            else {
              navigateView("routines"); setSearchFocusId(id);
              const url = new URL(window.location.href); url.searchParams.set("focus", id);
              window.history.replaceState(window.history.state, "", url);
            }
          }}
          onPatch={(patch) => patchItem(selectedTask.id, patch)}
          onAssignmentsChange={(assignments) => updateItemAssignments(selectedTask.id, assignments)}
          onNotice={showNotice}
          canDelete={deletableItemIds.has(selectedTask.id)}
          selected={selectedDeleteItemIds.has(selectedTask.id)}
          onToggleSelect={() => toggleDeleteSelection(selectedTask.id)}
        />
      )}
      {currentWorkspace && authState.user && <WorkspaceSearch key={`${authState.user.id}:${currentWorkspace.id}`} open={searchOpen} identity={authState.user.id} workspaceId={currentWorkspace.id} workspaceName={currentWorkspace.name} personal={currentWorkspace.personal} members={teamMembers} cycles={okrCycles} refreshKey={searchDataRevision} onClose={closeSearch} onNavigate={navigateSearch} />}
    </main>
  );
}

function AppLoadingScreen() {
  return (
    <main className="app-loading-shell" aria-busy="true" aria-label={t("OKRI 불러오는 중")}>
      <aside className="app-loading-sidebar" aria-hidden="true">
        <div className="app-loading-brand"><BrandLogo symbolOnly size="compact" decorative /><span><b>OKRI</b><small>Workspace</small></span></div>
        <div className="app-loading-nav">
          <i /><i /><i /><i /><i />
        </div>
        <div className="app-loading-profile"><i /><span /></div>
      </aside>
      <section className="app-loading-workspace">
        <header className="app-loading-topbar"><span /><div><i /><i /></div></header>
        <div className="app-loading-body">
          <div className="app-loading-copy">
            <h1>{t("목표와 실행을 준비하고 있습니다")}</h1>
            <p>{t("워크스페이스와 오늘의 할 일을 불러오는 중입니다.")}</p>
          </div>
          <div className="app-loading-command" aria-hidden="true"><i /><span /><b /></div>
          <div className="app-loading-surface" aria-hidden="true">
            <header><span /><div><i /><i /><i /></div></header>
            <div className="app-loading-table-head"><span /><span /><span /><span /></div>
            <div className="app-loading-table-row"><b /><span /><span /><span /></div>
            <div className="app-loading-table-row"><b /><span /><span /><span /></div>
            <div className="app-loading-table-row"><b /><span /><span /><span /></div>
          </div>
        </div>
      </section>
      <span className="sr-only" aria-live="polite">{t("OKRI 워크스페이스를 불러오고 있습니다.")}</span>
    </main>
  );
}

function startGoogleSignIn() {
  clearCachedBootstrap();
  const returnTo = `${window.location.pathname}${window.location.search}${window.location.hash}`;
  window.location.assign(`/api/auth/google?returnTo=${encodeURIComponent(returnTo)}`);
}

function invitationTokenFromLocation() {
  if (typeof window === "undefined") return null;
  const token = new URLSearchParams(window.location.hash.replace(/^#/, "")).get("invite")?.trim() ?? "";
  return /^[a-f0-9]{64}$/.test(token) ? token : null;
}

function InvitationDialog({ token, preview, loadError, onClose, onAccepted }: {
  token: string;
  preview: InvitationPreview | null;
  loadError: string;
  onClose: () => void;
  onAccepted: () => void;
}) {
  const [accepting, setAccepting] = useState(false);
  const [error, setError] = useState("");

  async function accept() {
    if (!preview || preview.status !== "pending" || accepting) return;
    setAccepting(true);
    setError("");
    const response = await fetch("/api/invitations/accept", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token }),
    });
    const data = await response.json() as { accepted?: boolean; workspaceName?: string; error?: string };
    setAccepting(false);
    if (!response.ok || !data.accepted) {
      setError(apiError(data, "초대를 수락하지 못했습니다."));
      return;
    }
    onAccepted();
  }

  const statusMessage = preview?.status === "expired"
    ? "이 초대는 만료되었습니다. 워크스페이스 관리자에게 재전송을 요청해 주세요."
    : preview?.status === "revoked"
      ? "취소된 초대입니다."
      : preview?.status === "accepted"
        ? "이미 가입이 완료된 초대입니다."
        : "초대받은 이메일과 같은 Google 계정으로 로그인한 경우에만 가입할 수 있습니다.";

  return (
    <OverlayDialog title={t("워크스페이스 초대")} dismissPolicy="critical" onRequestClose={() => onClose()}>
      {(requestClose) => <section className="invitation-dialog">
        <header>
          <div><span>{t("OKRI 초대")}</span><h2>{t("워크스페이스에 가입하기")}</h2></div>
          <button className="icon-button" onClick={() => requestClose("close-button")} aria-label={t("초대 창 닫기")} title={t("닫기")}><X size={17} /></button>
        </header>
        {!preview && !loadError ? (
          <div className="invitation-dialog-loading" role="status"><LoaderCircle className="spin" size={18} /><span>{t("초대를 확인하고 있습니다.")}</span></div>
        ) : loadError ? (
          <div className="invitation-dialog-error" role="alert"><AlertTriangle size={18} /><div><b>{t("초대를 확인할 수 없습니다.")}</b><p>{loadError}</p></div></div>
        ) : preview ? (
          <>
            <div className="invitation-workspace-card">
              <span className="brand-mark">{preview.workspace.name.slice(0, 1).toLocaleUpperCase()}</span>
              <div><h3>{preview.workspace.name}</h3><p>{t("{name}님이 {role} 역할로 초대했습니다.", { name: preview.inviterName, role: teamRoleLabel(preview.role) })}</p></div>
            </div>
            <dl className="invitation-details">
              <div><dt>{t("초대 계정")}</dt><dd>{preview.emailHint}</dd></div>
              <div><dt>{t("유효 기간")}</dt><dd>{t("{date}까지", { date: new Date(preview.expiresAt).toLocaleDateString(getClientLocale()) })}</dd></div>
            </dl>
            <p className={`invitation-status-copy status-${preview.status}`}>{statusMessage}</p>
            {error && <p className="invitation-dialog-error-text" role="alert">{error}</p>}
          </>
        ) : null}
        <footer>
          <button type="button" onClick={() => requestClose("close-button")}>{t("닫기")}</button>
          {preview?.status === "pending" && <button type="button" className="primary" disabled={accepting} onClick={() => void accept()}>{accepting ? <><LoaderCircle className="spin" size={14} />{t("가입 중")}</> : t("이 워크스페이스에 가입")}</button>}
        </footer>
      </section>}
    </OverlayDialog>
  );
}

function WelcomeModal({ language, onLanguageChange, onClose, onOpenMcp, onSetup }: {
  language: IntroLanguage;
  onLanguageChange: (language: IntroLanguage) => void;
  onClose: () => void;
  onOpenMcp: () => void;
  onSetup: () => void;
}) {
  const copy = getIntroCopy(t);
  const pointIcons = [Bot, Table2, CalendarCheck];
  return (
    <OverlayDialog title={copy.title} className="welcome-backdrop" onRequestClose={() => onClose()}>
      {(requestClose) => <section className="welcome-modal">
        <header className="welcome-toolbar">
          <div className="welcome-brand"><BrandLogo size="compact" /></div>
          <div className="language-select">
            <Languages size={14} />
            <label className="sr-only" htmlFor="intro-language">{copy.languageLabel}</label>
            <select id="intro-language" value={language} onChange={(event) => onLanguageChange(event.target.value as IntroLanguage)}>
              {introLanguages.map((entry) => <option value={entry.id} key={entry.id}>{entry.label}</option>)}
            </select>
          </div>
          <button className="icon-button" onClick={() => requestClose("close-button")} aria-label="Close"><X size={17} /></button>
        </header>
        <div className="welcome-content">
          <p className="welcome-eyebrow">{copy.eyebrow}</p>
          <h1 id="welcome-title">{copy.title}</h1>
          <p className="welcome-description">{copy.description}</p>
          <section className="welcome-hierarchy">
            <span>{copy.hierarchyLabel}</span>
            <div>{[t("Objective"), t("Key Result"), t("Initiative"), t("Project"), t("Task")].map((entry, index) => <span key={entry}><b>{entry}</b>{index < 4 && <ChevronRight size={13} />}</span>)}</div>
            <small>{copy.routineNote}</small>
          </section>
          <div className="welcome-points">
            {copy.points.map((point, index) => {
              const Icon = pointIcons[index];
              return <div key={point.title}><span><Icon size={16} /></span><div><b>{point.title}</b><p>{point.description}</p></div></div>;
            })}
          </div>
        </div>
        <footer className="welcome-actions">
          <button className="welcome-secondary" onClick={onSetup}>{t("처음부터 함께 설정하기")}</button>
          <button className="welcome-secondary" onClick={onOpenMcp}><Bot size={14} />{copy.mcpAction}</button>
          <button className="welcome-primary" onClick={() => requestClose("close-button")}>{copy.startAction}<ChevronRight size={14} /></button>
        </footer>
      </section>}
    </OverlayDialog>
  );
}

function ProfileNamePrompt({ member, onClose, onSaved }: { member: TeamMember; onClose: () => void; onSaved: (member: TeamMember) => void }) {
  const suggestedName = memberNameNeedsConfirmation(member) ? "" : member.displayName;
  const [name, setName] = useState(suggestedName);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  async function save(event: FormEvent) {
    event.preventDefault();
    const displayName = name.trim();
    if (!displayName || saving) return;
    setSaving(true);
    setError("");
    const response = await fetch("/api/team", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: member.id, displayName }),
    });
    const data = await response.json() as { member?: TeamMember; error?: string };
    setSaving(false);
    if (!response.ok || !data.member) {
      setError(apiError(data, "실명을 저장하지 못했습니다."));
      return;
    }
    onSaved(data.member);
  }

  return (
    <OverlayDialog title={t("실명 확인")} className="profile-name-backdrop" dirty={name !== suggestedName} initialFocus="input" onRequestClose={() => onClose()}>
      {(requestClose) => <section className="profile-name-modal">
        <header>
          <div>
            <h2 id="profile-name-title">{t("실명 확인")}</h2>
            <p>{t("팀에서 사용할 이름")}</p>
          </div>
          <button className="icon-button" onClick={() => requestClose("close-button")} aria-label={t("나중에")}><X size={17} /></button>
        </header>
        <form onSubmit={save}>
          <label>
            <span>{t("내 실명")}</span>
            <input value={name} onChange={(event) => setName(event.target.value)} maxLength={80} placeholder={t("홍길동")} />
          </label>
          {error && <p>{error}</p>}
          <footer>
            <button type="button" onClick={() => requestClose("close-button")}>{t("나중에")}</button>
            <button disabled={!name.trim() || saving}><Check size={14} />{t("저장")}</button>
          </footer>
        </form>
      </section>}
    </OverlayDialog>
  );
}

function CleanupModal({ onClose, onCleaned, onNotice }: { onClose: () => void; onCleaned: (cycle: OkrCycle) => void; onNotice: (message: string) => void }) {
  const confirmationText = "DELETE OKR DATA";
  const [confirm, setConfirm] = useState("");
  const [cleaning, setCleaning] = useState(false);

  async function clean() {
    if (confirm !== confirmationText || cleaning) return;
    setCleaning(true);
    const response = await fetch("/api/workspace-cleanup", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ confirmation: confirmationText }),
    });
    setCleaning(false);
    if (!response.ok) {
      onNotice(t("OKR 데이터를 정리하지 못했습니다."));
      return;
    }
    const data = await response.json() as { activeCycle: OkrCycle };
    onCleaned(data.activeCycle);
  }

  return (
    <OverlayDialog title={t("OKR 데이터 클린업")} dismissPolicy="critical" initialFocus="input" onRequestClose={() => onClose()}>
      {(requestClose) => <section className="cleanup-modal">
        <header>
          <div>
            <AlertTriangle size={18} />
            <h2 id="cleanup-title">{t("OKR 데이터 클린업")}</h2>
          </div>
          <button className="icon-button" onClick={() => requestClose("close-button")} aria-label={t("닫기")}><X size={17} /></button>
        </header>
        <p>
          {t("현재 워크스페이스의 Objective, Key Result, Initiative, Project, Task, Routine, Scrum 기록을 휴지통에 보관한 뒤 작업 화면에서 비웁니다. 워크스페이스, 멤버, 그룹, 연동, 속성 설정은 그대로 유지됩니다.")}</p>
        <label>
          <span>{t("확인 문구")}</span>
          <input value={confirm} onChange={(event) => setConfirm(event.target.value)} placeholder={confirmationText} />
        </label>
        <footer>
          <button onClick={() => requestClose("close-button")}>{t("취소")}</button>
          <button className="danger" disabled={confirm !== confirmationText || cleaning} onClick={() => void clean()}>
            {cleaning ? t("정리 중") : t("휴지통으로 이동")}
          </button>
        </footer>
      </section>}
    </OverlayDialog>
  );
}

function CadenceSwitch({ value, onChange }: { value: Cadence; onChange: (value: Cadence) => void }) {
  return <div className="cadence-switch">{(Object.keys(cadenceLabels) as Cadence[]).map((entry) => <button className={value === entry ? "selected" : ""} key={entry} onClick={() => onChange(entry)}>{cadenceLabels[entry]}</button>)}</div>;
}

function TaskDatabase({ items, allItems, properties, values, hiddenProperties, display, onDisplayChange, onPatch, onPropertyChange, onOpenProperties, onOpenTask, onOpenProject, canDeleteItem, selectedItemIds, onToggleSelect, onSelectItems, onClearItems }: {
  items: OkriItem[];
  allItems: OkriItem[];
  properties: PropertyDefinition[];
  values: PropertyValueMap;
  hiddenProperties: ProjectHiddenPropertyMap;
  display: "cards" | "table" | "board";
  onDisplayChange: (display: "cards" | "table" | "board") => void;
  onPatch: (id: string, patch: Partial<OkriItem>) => Promise<unknown>;
  onPropertyChange: (itemId: string, propertyId: string, value: PropertyValue) => Promise<void>;
  onOpenProperties: () => void;
  onOpenTask: (id: string) => void;
  onOpenProject: (id: string) => void;
  canDeleteItem: (item: OkriItem) => boolean;
  selectedItemIds: Set<string>;
  onToggleSelect: (id: string) => void;
  onSelectItems: (ids: string[]) => void;
  onClearItems: (ids: string[]) => void;
}) {
  const [query, setQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState<ItemStatus | "all">("all");
  const [priorityFilter, setPriorityFilter] = useState<Priority | "all">("all");
  const [driFilter, setDriFilter] = useState("all");
  const [dueFilter, setDueFilter] = useState<"all" | "overdue" | "week" | "none">("all");
  const [sort, setSort] = useState<"default" | "recent" | "due" | "priority" | "name">("default");
  const [filterOpen, setFilterOpen] = useState(false);
  const [sortOpen, setSortOpen] = useState(false);
  const [selectionMode, setSelectionMode] = useState(false);
  const actionsRef = useRef<HTMLDivElement>(null);
  const customProperties = properties.filter((property) => !property.systemKey && property.active);
  const byId = new Map(allItems.map((entry) => [entry.id, entry]));
  const emptyLabel = items.every((entry) => entry.kind === "project") ? "Project" : "Task";
  const activeFilterCount = [statusFilter !== "all", priorityFilter !== "all", driFilter !== "all", dueFilter !== "all"].filter(Boolean).length;
  const driOptions = Array.from(new Map(items.flatMap((entry) => entry.assignments.filter((assignment) => assignment.role === "project_dri")).map((assignment) => [assignment.memberId, assignment])).values());
  const today = localDate();
  const weekDate = new Date();
  weekDate.setDate(weekDate.getDate() + 7);
  const weekEnd = `${weekDate.getFullYear()}-${String(weekDate.getMonth() + 1).padStart(2, "0")}-${String(weekDate.getDate()).padStart(2, "0")}`;
  const priorityRank: Record<Priority, number> = { low: 1, medium: 2, high: 3, urgent: 4 };
  const visible = items
    .filter((entry) => entry.title.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()))
    .filter((entry) => statusFilter === "all" || entry.status === statusFilter)
    .filter((entry) => priorityFilter === "all" || entry.priority === priorityFilter)
    .filter((entry) => driFilter === "all" || entry.assignments.some((assignment) => assignment.role === "project_dri" && assignment.memberId === driFilter))
    .filter((entry) => dueFilter === "all" || dueFilter === "none" ? dueFilter === "all" || !entry.dueDate : dueFilter === "overdue" ? Boolean(entry.dueDate && entry.dueDate < today) : Boolean(entry.dueDate && entry.dueDate >= today && entry.dueDate <= weekEnd))
    .sort((left, right) => sort === "recent" ? right.updatedAt.localeCompare(left.updatedAt)
      : sort === "due" ? (left.dueDate ?? "9999-12-31").localeCompare(right.dueDate ?? "9999-12-31")
      : sort === "priority" ? priorityRank[right.priority] - priorityRank[left.priority]
      : sort === "name" ? left.title.localeCompare(right.title, "ko")
      : items.indexOf(left) - items.indexOf(right));
  const deletableVisible = visible.filter(canDeleteItem);
  const selectedVisibleCount = deletableVisible.filter((entry) => selectedItemIds.has(entry.id)).length;

  function closeSelectionMode() {
    onClearItems(deletableVisible.map((entry) => entry.id));
    setSelectionMode(false);
  }

  useEffect(() => {
    if (!filterOpen && !sortOpen) return;
    function closePopovers(event: Event) {
      if (event instanceof KeyboardEvent && event.key !== "Escape") return;
      if (event instanceof PointerEvent && actionsRef.current?.contains(event.target as Node)) return;
      setFilterOpen(false);
      setSortOpen(false);
    }
    window.addEventListener("pointerdown", closePopovers);
    window.addEventListener("keydown", closePopovers);
    return () => {
      window.removeEventListener("pointerdown", closePopovers);
      window.removeEventListener("keydown", closePopovers);
    };
  }, [filterOpen, sortOpen]);

  function resetFilters() {
    setStatusFilter("all");
    setPriorityFilter("all");
    setDriFilter("all");
    setDueFilter("all");
  }

  function propertyPreview(entry: OkriItem) {
    return customProperties
      .filter((property) => !(hiddenProperties[entry.id] ?? []).includes(property.id))
      .map((property) => ({ property, value: values[entry.id]?.[property.id] ?? null }))
      .filter(({ value }) => value !== null && value !== "" && (!Array.isArray(value) || value.length))
      .slice(0, 2);
  }

  return (
    <section className="database-section">
      <div className="database-toolbar">
        <div className="view-tabs" role="tablist" aria-label={t("Project 표시 방식")}>
          <button role="tab" aria-selected={display === "cards"} className={display === "cards" ? "active" : ""} onClick={() => onDisplayChange("cards")}><Briefcase size={13} />{t("카드")}</button>
          <button role="tab" aria-selected={display === "table"} className={display === "table" ? "active" : ""} onClick={() => onDisplayChange("table")}><Table2 size={13} />{t("테이블")}</button>
          <button role="tab" aria-selected={display === "board"} className={display === "board" ? "active" : ""} onClick={() => onDisplayChange("board")}><Columns3 size={13} />{t("보드")}</button>
        </div>
        <div className="database-actions" ref={actionsRef}>
          {deletableVisible.length > 0 && <button className={selectionMode ? "active" : ""} aria-label={selectionMode ? t("선택 종료") : t("선택")} aria-pressed={selectionMode} onClick={() => selectionMode ? closeSelectionMode() : setSelectionMode(true)}>{selectionMode ? <X size={13} /> : <ListChecks size={13} />}<span>{selectionMode ? t("선택 종료") : t("선택")}</span></button>}
          <label className="table-search"><Search size={13} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder={t("Project 검색")} aria-label={t("Project 검색")} /></label>
          <div className="toolbar-popover-wrap">
            <button aria-label={t("Project 필터")} title={t("Project 필터")} aria-haspopup="dialog" aria-expanded={filterOpen} onClick={() => { setFilterOpen((open) => !open); setSortOpen(false); }}><Filter size={13} /><span>{t("필터")}</span>{activeFilterCount > 0 && <b>{activeFilterCount}</b>}</button>
            {filterOpen && <section className="toolbar-popover" role="dialog" aria-label={t("Project 필터")}>
              <header><b>{t("필터")}</b>{activeFilterCount > 0 && <button onClick={resetFilters}>{t("전체 해제")}</button>}</header>
              <label><span>{t("상태")}</span><select value={statusFilter} onChange={(event) => setStatusFilter(event.target.value as ItemStatus | "all")}><option value="all">{t("전체")}</option>{Object.entries(statusLabels).filter(([value]) => value !== "archived").map(([value, label]) => <option value={value} key={value}>{label}</option>)}</select></label>
              <label><span>{t("우선순위")}</span><select value={priorityFilter} onChange={(event) => setPriorityFilter(event.target.value as Priority | "all")}><option value="all">{t("전체")}</option>{Object.entries(priorityLabels).map(([value, label]) => <option value={value} key={value}>{label}</option>)}</select></label>
              <label><span>{t("책임자")}</span><select value={driFilter} onChange={(event) => setDriFilter(event.target.value)}><option value="all">{t("전체")}</option>{driOptions.map((assignment) => <option value={assignment.memberId} key={assignment.memberId}>{assignment.displayName}</option>)}</select></label>
              <label><span>{t("마감")}</span><select value={dueFilter} onChange={(event) => setDueFilter(event.target.value as "all" | "overdue" | "week" | "none")}><option value="all">{t("전체")}</option><option value="overdue">{t("기한 초과")}</option><option value="week">{t("7일 이내")}</option><option value="none">{t("기한 없음")}</option></select></label>
              <footer><button onClick={() => setFilterOpen(false)}>{t("적용")}</button></footer>
            </section>}
          </div>
          <div className="toolbar-popover-wrap">
            <button aria-label={t("Project 정렬")} title={t("Project 정렬")} aria-haspopup="listbox" aria-expanded={sortOpen} onClick={() => { setSortOpen((open) => !open); setFilterOpen(false); }}><ArrowDownUp size={13} /><span>{t("정렬")}</span>{sort !== "default" && <i />}</button>
            {sortOpen && <div className="toolbar-popover sort-popover" role="listbox" aria-label={t("Project 정렬")}>{([
              ["default", t("기본순")], ["recent", t("최근 수정순")], ["due", t("마감 임박순")], ["priority", t("우선순위 높은순")], ["name", t("이름순")],
            ] as const).map(([value, label]) => <button role="option" aria-selected={sort === value} className={sort === value ? "active" : ""} key={value} onClick={() => { setSort(value); setSortOpen(false); }}>{label}{sort === value && <Check size={13} />}</button>)}</div>}
          </div>
          <button onClick={onOpenProperties} aria-label={t("Project 속성 관리")} title={t("Project 속성 관리")}><Plus size={13} /><span>{t("속성")}</span></button>
        </div>
      </div>
      {selectionMode && <div className="project-selection-bar" role="region" aria-label={t("Project 선택 모드")}><span>{t("삭제할 Project를 선택하세요")}</span><b>{t("{count}개 선택", { count: selectedVisibleCount })}</b><button onClick={() => selectedVisibleCount === deletableVisible.length ? onClearItems(deletableVisible.map((entry) => entry.id)) : onSelectItems(deletableVisible.map((entry) => entry.id))}>{selectedVisibleCount === deletableVisible.length ? t("전체 해제") : t("현재 목록 전체 선택")}</button></div>}
      {display === "cards" ? <div className="project-card-list" role="list" aria-label={t("Project 카드 목록")}>{visible.map((entry) => {
        const previews = propertyPreview(entry);
        return <article className={`project-card ${selectionMode ? "selection-mode" : ""}`} role="listitem" key={entry.id}>
          {selectionMode && canDeleteItem(entry) && <DeleteSelectCheckbox item={entry} selected={selectedItemIds.has(entry.id)} onToggle={onToggleSelect} />}
          <button className="project-card-open" onClick={() => onOpenProject(entry.id)}>
            <header><b className="project-item-title">{entry.title}</b><ChevronRight size={15} /></header>
            <div className="project-card-meta"><span className={`status-tag status-${entry.status}`}>{statusLabel(entry.status)}</span><span className={`priority-${entry.priority}`}>{priorityLabels[entry.priority]}</span><span><CalendarDays size={12} />{dueLabel(entry.dueDate)}</span><span><Users size={12} />{assignmentLabel(entry, "project_dri")}</span></div>
            <div className="project-card-relation"><Link2 size={12} /><span>{entry.parentId ? byId.get(entry.parentId)?.title ?? t("연결 없음") : t("연결 없음")}</span></div>
            {previews.length > 0 && <div className="project-card-properties">{previews.map(({ property, value }) => <span key={property.id}><small>{systemPropertyLabel(property, t)}</small><b>{Array.isArray(value) ? t("{value1}명", { value1: messageValue(value.length) }) : typeof value === "boolean" ? value ? t("예") : t("아니오") : String(value)}</b></span>)}</div>}
            <div className="project-card-progress"><span><i style={{ width: `${entry.progress}%` }} /></span><b>{entry.progress}%</b></div>
          </button>
        </article>;
      })}{!visible.length && <div className="table-empty">{activeFilterCount || query ? <><span>{t("조건에 맞는 Project가 없습니다.")}</span><button onClick={() => { resetFilters(); setQuery(""); }}>{t("검색·필터 초기화")}</button></> : t("표시할 Project가 없습니다.")}</div>}</div>
      : display === "board" ? <BoardView items={visible} onOpenItem={(entry) => entry.kind === "project" ? onOpenProject(entry.id) : onOpenTask(entry.id)} canDeleteItem={canDeleteItem} selectedItemIds={selectedItemIds} onToggleSelect={onToggleSelect} selectionMode={selectionMode} /> : (
        <div className="database-scroll">
          <div className="task-table" role="table" aria-label={t("Project 표")} style={{ "--custom-columns": customProperties.length, "--custom-column-tracks": customProperties.length ? `repeat(${customProperties.length}, var(--custom-column-width))` : " " } as CSSProperties}>
            <div className="task-table-row task-table-head" role="row">
              <span role="columnheader"><ListChecks size={12} />{t("이름")}</span><span role="columnheader"><Activity size={12} />{t("상태")}</span><span role="columnheader"><Zap size={12} />{t("우선순위")}</span><span role="columnheader"><CalendarDays size={12} />{t("기한")}</span><span role="columnheader"><Link2 size={12} />{t("상위 Initiative")}</span><span role="columnheader"><Users size={12} />{t("책임자")}</span>
              {customProperties.map((property) => <span role="columnheader" key={property.id}>{property.type === "number" ? <Hash size={12} /> : <TextCursorInput size={12} />}{systemPropertyLabel(property, t)}</span>)}
              <button aria-label={t("속성 추가")} title={t("속성 추가")} onClick={onOpenProperties}><Plus size={13} /></button>
            </div>
            {visible.map((entry) => (
              <div className="task-table-row" role="row" key={entry.id}>
                <div className="name-cell">{selectionMode && canDeleteItem(entry) && <DeleteSelectCheckbox item={entry} selected={selectedItemIds.has(entry.id)} onToggle={onToggleSelect} />}<button className={`task-check ${isCompletedStatus(entry.status) ? "checked" : ""}`} aria-label={`${entry.title} ${isCompletedStatus(entry.status) ? t("완료 취소") : t("완료 처리")}`} aria-pressed={isCompletedStatus(entry.status)} onClick={() => void onPatch(entry.id, { status: isCompletedStatus(entry.status) ? "todo" : "done", progress: isCompletedStatus(entry.status) ? entry.progress : 100 })}><Check size={12} /></button>{entry.kind === "project" ? <button className="name-open-button project-item-title" onClick={() => onOpenProject(entry.id)}>{entry.title}</button> : <input defaultValue={entry.title} onBlur={(event) => event.target.value.trim() !== entry.title && void onPatch(entry.id, { title: event.target.value })} />}</div>
                <select aria-label={t("{value1} 상태", { value1: messageValue(entry.title) })} className={`status-select status-${entry.status}`} value={entry.status} onChange={(event) => void onPatch(entry.id, { status: event.target.value as ItemStatus })}>{Object.entries(statusLabels).filter(([value]) => value !== "archived").map(([value, label]) => <option value={value} key={value}>{label}</option>)}</select>
                <select aria-label={t("{value1} 우선순위", { value1: messageValue(entry.title) })} className={`priority-${entry.priority}`} value={entry.priority} onChange={(event) => void onPatch(entry.id, { priority: event.target.value as Priority })}>{Object.entries(priorityLabels).map(([value, label]) => <option value={value} key={value}>{label}</option>)}</select>
                <input aria-label={t("{value1} 기한", { value1: messageValue(entry.title) })} className="date-cell" type="date" value={entry.dueDate ?? ""} onChange={(event) => void onPatch(entry.id, { dueDate: event.target.value || null })} />
                <span className="relation-cell">{entry.parentId ? byId.get(entry.parentId)?.title ?? t("연결 없음") : t("연결 없음")}</span>
                <span className="relation-cell assignment-cell">{assignmentLabel(entry, "project_dri")}</span>
                {customProperties.map((property) => (hiddenProperties[entry.id] ?? []).includes(property.id)
                  ? <span className="hidden-property-cell" key={property.id} title={t("이 Project에서 숨긴 속성")}>—</span>
                  : <PropertyCell key={property.id} itemId={entry.id} property={property} value={values[entry.id]?.[property.id] ?? null} onChange={onPropertyChange} />)}
                {entry.kind === "task" ? <button className="row-menu" aria-label="Task detail" title="Task detail" onClick={() => onOpenTask(entry.id)}><MoreHorizontal size={15} /></button> : entry.kind === "project" ? <button className="row-menu" aria-label={t("Project 속성")} title={t("Project 속성")} onClick={() => onOpenProject(entry.id)}><MoreHorizontal size={15} /></button> : <span className="row-menu" />}
              </div>
            ))}
            {!visible.length && <div className="table-empty">{activeFilterCount || query ? <><span>{t("조건에 맞는 {kind}가 없습니다.", { kind: emptyLabel })}</span><button onClick={() => { resetFilters(); setQuery(""); }}>{t("검색·필터 초기화")}</button></> : t("표시할 {value1}가 없습니다.", { value1: messageValue(emptyLabel) })}</div>}
          </div>
        </div>
      )}
    </section>
  );
}

function PropertyCell({ itemId, property, value, onChange }: { itemId: string; property: PropertyDefinition; value: PropertyValue; onChange: (itemId: string, propertyId: string, value: PropertyValue) => Promise<void> }) {
  if (property.type === "checkbox") return <label className="property-checkbox"><input type="checkbox" checked={Boolean(value)} onChange={(event) => void onChange(itemId, property.id, event.target.checked)} /><span><Check size={11} /></span></label>;
  if (property.type === "select") return <select className="property-input" value={typeof value === "string" ? value : ""} onChange={(event) => void onChange(itemId, property.id, event.target.value || null)}><option value="">-</option>{property.options.map((option) => <option key={option}>{option}</option>)}</select>;
  if (property.type === "member" || property.type === "members") return <span className="relation-cell assignment-cell">{Array.isArray(value) ? t("{value1}명", { value1: messageValue(value.length) }) : value ? t("1명") : t("미지정")}</span>;
  return <input className="property-input" type={property.type === "number" ? "number" : property.type === "date" ? "date" : "text"} value={value === null ? "" : String(value)} onChange={(event) => { const raw = event.target.value; void onChange(itemId, property.id, property.type === "number" ? (raw ? Number(raw) : null) : raw || null); }} />;
}

function documentPropertyValue(property: PropertyDefinition, value: PropertyValue, members: TeamMember[]) {
  if (value === null || value === undefined || value === "" || Array.isArray(value) && !value.length) return t("미지정");
  if (property.type === "checkbox") return value ? t("완료") : t("아니요");
  if (property.type === "member" || property.type === "members") return (Array.isArray(value) ? value : [String(value)]).map(id => members.find(member => member.id === id)?.displayName ?? t("미지정")).join(", ");
  return Array.isArray(value) ? value.join(", ") : String(value);
}

function ProjectPageView({ project, allItems, properties, propertyValues, hiddenPropertyIds, teamMembers, onClose, onBackToList, onPatch, onPropertyChange, onPropertyVisibility, onAssignmentsChange, onTaskCreated, onItemsRefresh, onOpenTask, readOnly, onNotice, onArchive, canDeleteItem, selectedItemIds, onToggleSelect }: {
  project: OkriItem;
  onBackToList: () => void;
  allItems: OkriItem[];
  properties: PropertyDefinition[];
  propertyValues: PropertyValueMap;
  hiddenPropertyIds: string[];
  teamMembers: TeamMember[];
  onClose: () => void;
  onPatch: (id: string, patch: Partial<OkriItem>) => Promise<unknown>;
  onPropertyChange: (itemId: string, propertyId: string, value: PropertyValue) => Promise<void>;
  onPropertyVisibility: (propertyId: string, hidden: boolean) => void;
  onAssignmentsChange: (itemId: string, assignments: ItemAssignment[]) => void;
  onTaskCreated: (task: OkriItem) => void;
  onItemsRefresh: (items: OkriItem[]) => void;
  onOpenTask: (id: string) => void;
  readOnly: boolean;
  onNotice: (message: string) => void;
  onArchive: () => void;
  canDeleteItem: (item: OkriItem) => boolean;
  selectedItemIds: Set<string>;
  onToggleSelect: (id: string) => void;
}) {
  const confirmAction = useAppConfirm();
  const [quickTaskTitle, setQuickTaskTitle] = useState("");
  const [creatingTask, setCreatingTask] = useState(false);
  const [addingTask, setAddingTask] = useState(false);
  const [progressBotEnabled, setProgressBotEnabled] = useState(false);
  const [progressBotRefreshing, setProgressBotRefreshing] = useState(false);
  const [progressBotCheckedAt, setProgressBotCheckedAt] = useState<string | null>(null);
  const progressBotRefreshHandler = useRef(onItemsRefresh);
  const progressBotNoticeHandler = useRef(onNotice);
  const byId = new Map(allItems.map((entry) => [entry.id, entry]));
  const initiative = project.parentId ? byId.get(project.parentId) : undefined;
  const keyResult = initiative?.parentId ? byId.get(initiative.parentId) : undefined;
  const objective = keyResult?.parentId ? byId.get(keyResult.parentId) : undefined;
  const initiatives = allItems.filter((entry) => entry.kind === "initiative");
  const activeProperties = properties.filter((property) => property.active);
  const customProperties = activeProperties.filter((property) => !property.systemKey);
  const visibleProperties = customProperties.filter((property) => !hiddenPropertyIds.includes(property.id));
  const hiddenPropertyDefinitions = activeProperties.filter((property) => hiddenPropertyIds.includes(property.id));
  const systemProperties = new Map(properties.filter((property) => property.systemKey).map((property) => [property.systemKey!, property]));
  const linkedTasks = allItems.filter((entry) => entry.kind === "task" && entry.parentId === project.id && !entry.archivedAt);
  const deletableLinkedTasks = linkedTasks.filter(canDeleteItem);
  const driIds = project.assignments.filter((entry) => entry.role === "project_dri").map((entry) => entry.memberId);
  const workerIds = project.assignments.filter((entry) => entry.role === "project_worker").map((entry) => entry.memberId);

  useEffect(() => { progressBotRefreshHandler.current = onItemsRefresh; }, [onItemsRefresh]);
  useEffect(() => { progressBotNoticeHandler.current = onNotice; }, [onNotice]);
  useEffect(() => {
    const timer = window.setTimeout(() => {
      try { setProgressBotEnabled(window.localStorage.getItem(`okri.project-progress-bot.${project.id}`) === "1"); }
      catch { setProgressBotEnabled(false); }
    }, 0);
    return () => window.clearTimeout(timer);
  }, [project.id]);

  const refreshProgressBot = useCallback(async (quiet = false) => {
    if (!quiet) setProgressBotRefreshing(true);
    try {
      const [projectResponse, taskResponse] = await Promise.all([
        fetch("/api/items?kind=project", { cache: "no-store" }),
        fetch(`/api/items?kind=task&parentId=${encodeURIComponent(project.id)}`, { cache: "no-store" }),
      ]);
      if (!projectResponse.ok || !taskResponse.ok) throw new Error("refresh failed");
      const [projectData, taskData] = await Promise.all([
        projectResponse.json() as Promise<{ items: OkriItem[] }>,
        taskResponse.json() as Promise<{ items: OkriItem[] }>,
      ]);
      const freshProject = projectData.items.find((entry) => entry.id === project.id);
      progressBotRefreshHandler.current([...(freshProject ? [freshProject] : []), ...taskData.items]);
      setProgressBotCheckedAt(new Date().toISOString());
    } catch {
      if (!quiet) progressBotNoticeHandler.current(t("최신 진행 상황을 확인하지 못했습니다."));
    } finally {
      if (!quiet) setProgressBotRefreshing(false);
    }
  }, [project.id]);

  useEffect(() => {
    if (!progressBotEnabled) return;
    const initial = window.setTimeout(() => void refreshProgressBot(true), 0);
    const interval = window.setInterval(() => {
      if (document.visibilityState === "visible") void refreshProgressBot(true);
    }, 30_000);
    return () => { window.clearTimeout(initial); window.clearInterval(interval); };
  }, [progressBotEnabled, refreshProgressBot]);

  function setProgressBot(next: boolean) {
    setProgressBotEnabled(next);
    try { window.localStorage.setItem(`okri.project-progress-bot.${project.id}`, next ? "1" : "0"); } catch { /* Browser storage is optional. */ }
    if (next) void refreshProgressBot(true);
    onNotice(next ? t("진행사항 봇을 켰습니다.") : t("진행사항 봇을 껐습니다."));
  }

  function systemProperty(key: string) {
    return systemProperties.get(key);
  }

  function systemPropertyVisible(key: string) {
    const property = systemProperty(key);
    return property ? property.active && !hiddenPropertyIds.includes(property.id) : true;
  }

  const propertyEntries: DocumentProperty[] = [
    { key: "status", label: systemPropertyLabel(systemProperty("status"), t, "상태"), value: statusLabels[project.status], primary: true },
    { key: "project_dri", label: systemPropertyLabel(systemProperty("project_dri"), t, "책임자"), value: assignmentLabel(project, "project_dri"), primary: true },
    { key: "due_date", label: systemPropertyLabel(systemProperty("due_date"), t, "기한"), value: dueLabel(project.dueDate), primary: true },
    { key: "priority", label: systemPropertyLabel(systemProperty("priority"), t, "우선순위"), value: priorityLabels[project.priority] },
    { key: "parent_id", label: systemPropertyLabel(systemProperty("parent_id"), t, "상위 Initiative"), value: initiative?.title ?? t("연결 없음") },
    { key: "project_workers", label: systemPropertyLabel(systemProperty("project_workers"), t, "하위 업무자"), value: assignmentLabel(project, "project_worker") },
  ].filter(entry => systemPropertyVisible(entry.key));
  propertyEntries.push(...visibleProperties.map(property => ({ key: property.id, label: systemPropertyLabel(property, t), value: documentPropertyValue(property, propertyValues[project.id]?.[property.id] ?? null, teamMembers) })));

  async function saveAssignments(role: "project_dri" | "project_worker", memberIds: string[]) {
    const response = await fetch("/api/item-assignments", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ itemId: project.id, role, memberIds }),
    });
    if (!response.ok) { onNotice(t("담당자를 저장하지 못했습니다.")); return; }
    const data = await response.json() as { assignments: ItemAssignment[] };
    onAssignmentsChange(project.id, data.assignments);
  }

  async function saveTaskAssignee(task: OkriItem, memberId: string) {
    const response = await fetch("/api/item-assignments", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ itemId: task.id, role: "task_assignee", memberIds: memberId ? [memberId] : [] }),
    });
    if (!response.ok) { onNotice(t("담당자를 저장하지 못했습니다.")); return; }
    const data = await response.json() as { assignments: ItemAssignment[] };
    onAssignmentsChange(task.id, data.assignments);
  }

  async function createLinkedTask(event: FormEvent) {
    event.preventDefault();
    const title = quickTaskTitle.trim();
    if (!title || creatingTask || readOnly) return;
    setCreatingTask(true);
    const response = await fetch("/api/items", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title, kind: "task", parentId: project.id, cycleId: project.cycleId, source: "web" }),
    });
    setCreatingTask(false);
    if (!response.ok) { onNotice(t("Task를 만들지 못했습니다.")); return; }
    const data = await response.json() as { item: OkriItem };
    onTaskCreated(data.item);
    setQuickTaskTitle("");
    onNotice(t("Project에 Task를 추가했습니다."));
  }
  return (
    <OverlayDialog title={t("{value1} Project 상세", { value1: messageValue(project.title) })} variant="drawer" dirty={Boolean(quickTaskTitle.trim())} history={false} onRequestClose={() => onClose()}>
      {(requestClose) => <aside className={`property-panel project-detail-panel ${project.status === "archived" ? "archived" : ""}`}>
        <header className="project-page-head">
          <div>
            <button type="button" className="detail-parent-link" onClick={async () => { if (!quickTaskTitle.trim() || await confirmAction({ title: t("변경사항을 버릴까요?"), message: t("저장하지 않은 변경사항이 있습니다. 닫으면 작성한 내용이 사라집니다."), confirmLabel: t("변경사항 버리기"), danger: true })) onBackToList(); }}><ArrowLeft size={14} />{t("Project 목록")}</button>
            <h2 className="document-title">{project.title}</h2>
          </div>
          <div className="project-page-actions">
            {canDeleteItem(project) && <DeleteSelectCheckbox item={project} selected={selectedItemIds.has(project.id)} onToggle={onToggleSelect} />}
            {canDeleteItem(project) && <button type="button" className="icon-button danger" onClick={onArchive} aria-label={t("Project 휴지통으로 이동")} title={t("Project 휴지통으로 이동")}><Trash2 size={16} /></button>}
            <button className="icon-button" onClick={() => requestClose("close-button")} aria-label={t("닫기")}><X size={17} /></button>
          </div>
        </header>
        <LocalAgentLauncher targetKind="project" targetId={project.id} targetTitle={project.title} readOnly={readOnly} onNotice={onNotice} />
        <div className="project-detail-content">
          <aside className="project-context-column" aria-label={t("Project 정보")}>
        <DocumentProperties entries={propertyEntries} readOnly={readOnly}>{() => <>
        <form className="property-form project-detail-form" onSubmit={event => event.preventDefault()}>
          <label><span>{t("Project 이름")}</span><textarea aria-label={t("Project 이름")} defaultValue={project.title} rows={2} onBlur={event => { const title = event.target.value.trim(); if (title && title !== project.title) void onPatch(project.id, { title }); }} /></label>
          {systemPropertyVisible("parent_id") && <ProjectSystemPropertySlot property={systemProperty("parent_id")} readOnly={readOnly} onHide={onPropertyVisibility}><label><span>{systemPropertyLabel(systemProperty("parent_id"), t, "상위 Initiative")}</span><select disabled={readOnly} value={project.parentId ?? ""} onChange={(event) => void onPatch(project.id, { parentId: event.target.value || null })}><option value="">{t("선택")}</option>{initiatives.map((entry) => <option value={entry.id} key={entry.id}>{entry.title}</option>)}</select></label></ProjectSystemPropertySlot>}
          <div className="project-field-grid">
            {systemPropertyVisible("priority") && <ProjectSystemPropertySlot property={systemProperty("priority")} readOnly={readOnly} onHide={onPropertyVisibility}><label><span>{systemPropertyLabel(systemProperty("priority"), t, "우선순위")}</span><select disabled={readOnly} className={`priority-${project.priority}`} value={project.priority} onChange={(event) => void onPatch(project.id, { priority: event.target.value as Priority })}>{Object.entries(priorityLabels).map(([value, label]) => <option value={value} key={value}>{label}</option>)}</select></label></ProjectSystemPropertySlot>}
            {systemPropertyVisible("status") && <ProjectSystemPropertySlot property={systemProperty("status")} readOnly={readOnly} onHide={onPropertyVisibility}><label><span>{systemPropertyLabel(systemProperty("status"), t, "상태")}</span><select disabled={readOnly} value={project.status} onChange={(event) => void onPatch(project.id, { status: event.target.value as ItemStatus })}>{Object.entries(statusLabels).filter(([value]) => value !== "archived").map(([value, label]) => <option value={value} key={value}>{label}</option>)}</select></label></ProjectSystemPropertySlot>}
            {systemPropertyVisible("due_date") && <ProjectSystemPropertySlot property={systemProperty("due_date")} readOnly={readOnly} onHide={onPropertyVisibility}><label><span>{systemPropertyLabel(systemProperty("due_date"), t, "기한")}</span><input disabled={readOnly} type="date" value={project.dueDate ?? ""} onChange={(event) => void onPatch(project.id, { dueDate: event.target.value || null })} /></label></ProjectSystemPropertySlot>}
          </div>
          {teamMembers.length > 0 && systemPropertyVisible("project_dri") && <ProjectSystemPropertySlot property={systemProperty("project_dri")} readOnly={readOnly} onHide={onPropertyVisibility}><MemberMentionPicker label={systemPropertyLabel(systemProperty("project_dri"), t, "책임자")} members={teamMembers} selectedIds={driIds} disabled={readOnly} onChange={(ids) => !readOnly && void saveAssignments("project_dri", ids)} placeholder={t("@실명으로 찾기")} maxSelected={1} /></ProjectSystemPropertySlot>}
          {teamMembers.length > 0 && systemPropertyVisible("project_workers") && <ProjectSystemPropertySlot property={systemProperty("project_workers")} readOnly={readOnly} onHide={onPropertyVisibility}><MemberMentionPicker label={systemPropertyLabel(systemProperty("project_workers"), t, "하위 업무자")} members={teamMembers} selectedIds={workerIds} disabled={readOnly} onChange={(ids) => !readOnly && void saveAssignments("project_worker", ids)} placeholder={t("@실명으로 여러 명 태그")} /></ProjectSystemPropertySlot>}
        </form>
        <section className="project-custom-properties">
          <header><b>{t("Project 속성")}</b><span>{readOnly ? t("읽기 전용") : t("변경 즉시 저장")}</span></header>
          {visibleProperties.length ? <div className="project-field-grid">{visibleProperties.map((property) => <ProjectPropertyField key={property.id} projectId={project.id} property={property} value={propertyValues[project.id]?.[property.id] ?? null} members={teamMembers} readOnly={readOnly} onChange={onPropertyChange} onHide={() => onPropertyVisibility(property.id, true)} />)}</div> : <EmptyState icon={Settings2} title={t("표시 중인 커스텀 속성이 없습니다")} />}
          {hiddenPropertyDefinitions.length > 0 && <div className="hidden-property-list"><span>{t("숨긴 속성")}{hiddenPropertyDefinitions.length}</span>{hiddenPropertyDefinitions.map((property) => <button type="button" disabled={readOnly} key={property.id} onClick={() => onPropertyVisibility(property.id, false)}><Eye size={13} />{systemPropertyLabel(property, t)}</button>)}</div>}
        </section>
        <div className="project-progress-bot-control"><span><Bot size={15} />{t("진행사항 봇")}</span><label className="project-bot-switch"><input type="checkbox" checked={progressBotEnabled} onChange={event => setProgressBot(event.target.checked)} aria-label={t("진행사항 봇 사용")} /><span aria-hidden="true" /></label></div>
        </>}</DocumentProperties>
        <details className="document-related"><summary>{t("상위 OKR")} · {t("연결 데이터")}</summary>
        <ProjectDataSection key={`data:${project.id}`} project={project} />
        <section className="task-lineage project-lineage-compact">
          <header><b>{t("상위 OKR")}</b><span>Objective → KR → Initiative</span></header>
          <LineageRow label={t("Objective")} value={objective?.title ?? "미연결"} />
          <LineageRow label={t("Key Result")} value={keyResult?.title ?? "미연결"} />
          <LineageRow label={t("Initiative")} value={initiative?.title ?? "미연결"} />
        </section>
        </details>
          </aside>
          <main className="project-primary-column">
            <ProjectDocumentSection key={`document:${project.id}`} projectId={project.id} readOnly={readOnly} onNotice={onNotice} />
            <ProjectProgressSection
              project={project}
              tasks={linkedTasks}
              teamMembers={teamMembers}
              botEnabled={progressBotEnabled}
              botRefreshing={progressBotRefreshing}
              botCheckedAt={progressBotCheckedAt}
              readOnly={readOnly}
              onRefresh={() => void refreshProgressBot()}
              onPatch={onPatch}
              onSaveTaskAssignee={saveTaskAssignee}
              onOpenTask={onOpenTask}
            />
            <section className="project-linked-tasks">
              <header><div><b>{t("연결된 Task")}</b><span>{t("{count}개", { count: linkedTasks.length })}</span></div>{deletableLinkedTasks.length > 0 && <button onClick={() => deletableLinkedTasks.forEach((task) => { if (!selectedItemIds.has(task.id)) onToggleSelect(task.id); })}><ListChecks size={13} />{t("삭제 가능 Task 선택")}</button>}</header>
              {!readOnly && !addingTask && <button className="secondary" type="button" onClick={() => setAddingTask(true)}><Plus size={15} />{t("Task 추가")}</button>}
              {addingTask && <form className="project-task-quick-add" onSubmit={createLinkedTask}>
                <input value={quickTaskTitle} onChange={(event) => setQuickTaskTitle(event.target.value)} aria-label={t("새 Task 이름")} placeholder={t("새 Task 빠른 추가")} disabled={readOnly || creatingTask} />
                <button disabled={readOnly || creatingTask || !quickTaskTitle.trim()} aria-label={t("Task 추가")} title={t("Task 추가")}><Plus size={15} /></button>
              </form>}
              <div className="project-task-table">
                <div className="project-task-row project-task-head"><span>{t("Task")}</span><span>{t("완료")}</span><span>{t("담당자")}</span><span>{t("마감일")}</span></div>
                {linkedTasks.map((task) => {
                  return <div className="project-task-row" key={task.id}>
                    <div className="project-task-title-cell">{canDeleteItem(task) && <DeleteSelectCheckbox item={task} selected={selectedItemIds.has(task.id)} onToggle={onToggleSelect} />}<button className="project-task-title" onClick={() => onOpenTask(task.id)}>{task.title}</button></div>
                    <button type="button" disabled={readOnly} className={`project-task-completion ${isCompletedStatus(task.status) ? "completed" : ""}`} aria-pressed={isCompletedStatus(task.status)} aria-label={`${task.title} ${isCompletedStatus(task.status) ? t("완료 취소") : t("완료")}`} onClick={() => void onPatch(task.id, taskCompletionPatch(task.status))}><span><Check size={12} /></span></button>
                    <span className="document-task-value">{assignmentLabel(task, "task_assignee")}</span>
                    <span className="document-task-value">{dueLabel(task.dueDate)}</span>
                  </div>;
                })}
                {!linkedTasks.length && <div className="project-task-empty">{t("연결된 Task가 없습니다.")}</div>}
              </div>
            </section>
          </main>
        </div>
      </aside>}
    </OverlayDialog>
  );
}

function ProjectProgressSection({ project, tasks, teamMembers, botEnabled, botRefreshing, botCheckedAt, readOnly, onRefresh, onPatch, onSaveTaskAssignee, onOpenTask }: {
  project: OkriItem;
  tasks: OkriItem[];
  teamMembers: TeamMember[];
  botEnabled: boolean;
  botRefreshing: boolean;
  botCheckedAt: string | null;
  readOnly: boolean;
  onRefresh: () => void;
  onPatch: (id: string, patch: Partial<OkriItem>) => Promise<unknown>;
  onSaveTaskAssignee: (task: OkriItem, memberId: string) => Promise<void>;
  onOpenTask: (id: string) => void;
}) {
  const today = new Date().toLocaleDateString("sv-SE");
  const completed = tasks.filter((task) => isCompletedStatus(task.status));
  const blocked = tasks.filter((task) => task.status === "blocked");
  const taskProgress = tasks.length ? Math.round((completed.length / tasks.length) * 100) : project.progress;
  const needsOwner = tasks.filter((task) => !isCompletedStatus(task.status) && !task.assignments.some((assignment) => assignment.role === "task_assignee"));
  const needsDueDate = tasks.filter((task) => !isCompletedStatus(task.status) && !task.dueDate);
  const overdue = tasks.filter((task) => !isCompletedStatus(task.status) && Boolean(task.dueDate && task.dueDate < today));
  const progressDiffers = tasks.length > 0 && project.progress !== taskProgress;
  const reviewCount = needsOwner.length + needsDueDate.length + overdue.length + (progressDiffers ? 1 : 0);
  const recent = [...tasks].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, 6);

  return <section className="project-progress-section" aria-labelledby="project-progress-heading">
    <header className="project-progress-header">
      <div><h3 id="project-progress-heading">{t("진행 상황")}</h3></div>
    </header>
    <div className="project-progress-overview">
      <div className="project-progress-value"><strong>{project.progress}%</strong><span>{t("Project 진행률")}</span></div>
      <div className="project-progress-track" aria-label={t("Project 진행률")} aria-valuemin={0} aria-valuemax={100} aria-valuenow={project.progress} role="progressbar"><i style={{ width: `${project.progress}%` }} /></div>
      <dl><div><dt>{t("완료")}</dt><dd>{completed.length} / {tasks.length}</dd></div><div><dt>{t("막힘")}</dt><dd>{blocked.length}</dd></div><div><dt>{t("확인 필요")}</dt><dd>{botEnabled ? reviewCount : "—"}</dd></div></dl>
    </div>
    {botEnabled ? <div className="project-bot-workspace">
      <header><div><b>{reviewCount ? t("봇이 확인을 기다리고 있습니다") : t("정리할 항목이 없습니다")}</b><span>{t("애매한 값은 바꾸지 않고 먼저 묻습니다.")}</span></div><button type="button" className="icon-button" disabled={botRefreshing} aria-label={t("진행 상황 새로고침")} onClick={onRefresh}>{botRefreshing ? <LoaderCircle className="spinning" size={15} /> : <RefreshCw size={15} />}</button></header>
      {reviewCount > 0 && <div className="project-bot-review-list">
        {progressDiffers && <article className="project-bot-review-row"><AlertTriangle size={16} /><div><b>{t("Task 완료율과 Project 진행률이 다릅니다.")}</b><p>{t("Task 기준 {value1}%로 맞출까요?", { value1: messageValue(taskProgress) })}</p></div><button type="button" disabled={readOnly} onClick={() => void onPatch(project.id, { progress: taskProgress })}>{t("진행률 반영")}</button></article>}
        {needsOwner.map((task) => <article className="project-bot-review-row" key={`owner:${task.id}`}><AlertTriangle size={16} /><div><button type="button" className="project-bot-task-link" onClick={() => onOpenTask(task.id)}>{task.title}</button><p>{t("담당자가 없습니다. 누가 맡을까요?")}</p></div><select aria-label={t("{value1} 담당자", { value1: messageValue(task.title) })} disabled={readOnly} defaultValue="" onChange={(event) => void onSaveTaskAssignee(task, event.target.value)}><option value="">{t("담당자 선택")}</option>{teamMembers.filter((member) => member.status === "active").map((member) => <option value={member.id} key={member.id}>{member.displayName}</option>)}</select></article>)}
        {needsDueDate.map((task) => <article className="project-bot-review-row" key={`due:${task.id}`}><CalendarDays size={16} /><div><button type="button" className="project-bot-task-link" onClick={() => onOpenTask(task.id)}>{task.title}</button><p>{t("기한이 없습니다. 언제까지 할까요?")}</p></div><input aria-label={t("{value1} 기한", { value1: messageValue(task.title) })} disabled={readOnly} type="date" onChange={(event) => event.target.value && void onPatch(task.id, { dueDate: event.target.value })} /></article>)}
        {overdue.map((task) => <article className="project-bot-review-row overdue" key={`overdue:${task.id}`}><AlertTriangle size={16} /><div><button type="button" className="project-bot-task-link" onClick={() => onOpenTask(task.id)}>{task.title}</button><p>{t("기한이 지났습니다. 상태를 막힘으로 바꿀까요, 기한을 다시 잡을까요?")}</p></div><div className="project-bot-inline-actions"><button type="button" disabled={readOnly} onClick={() => void onPatch(task.id, { status: "blocked" })}>{t("막힘으로 변경")}</button><input aria-label={t("{value1} 새 기한", { value1: messageValue(task.title) })} disabled={readOnly} type="date" min={today} onChange={(event) => event.target.value && void onPatch(task.id, { dueDate: event.target.value })} /></div></article>)}
      </div>}
      <p className="project-bot-last-check">{botCheckedAt ? t("최근 확인 · {value1}", { value1: messageValue(formatDateTime(botCheckedAt)) }) : t("변경사항을 확인하고 있습니다.")}</p>
    </div> : null}
    <div className="project-update-feed">
      <header><b>{t("최근 업데이트")}</b><span>{t("최신순")}</span></header>
      {recent.map((task) => <button type="button" key={task.id} onClick={() => onOpenTask(task.id)}><span className={`status-dot status-${task.status}`} /><span><b>{task.title}</b><small>{isCompletedStatus(task.status) ? t("완료됨") : statusLabels[task.status]} · {formatDateTime(task.updatedAt)}</small></span><ChevronRight size={15} /></button>)}
      {!recent.length && <p className="project-update-empty">{t("아직 쌓인 Task 업데이트가 없습니다.")}</p>}
    </div>
  </section>;
}

function ProjectDataSection({ project }: { project: OkriItem }) {
  const [connection, setConnection] = useState<ProjectDataConnection | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    let active = true;
    void fetch(`/api/data-connections?itemId=${encodeURIComponent(project.id)}`, { signal: controller.signal })
      .then(async (response) => response.ok ? response.json() as Promise<{ connections: ProjectDataConnection[] }> : Promise.reject())
      .then((data) => { if (active) setConnection(data.connections[0] ?? null); })
      .catch((error: unknown) => {
        if (active && !(error instanceof DOMException && error.name === "AbortError")) setLoadError(true);
      })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; controller.abort(); };
  }, [project.id]);

  return <section className="project-linked-data">
    <header><div><b>{t("연결 데이터")}</b><span>{connection ? t("1개") : t("연결 없음")}</span></div><Database size={15} /></header>
    {loading ? <div className="project-data-state"><LoaderCircle className="spinning" size={15} />{t("데이터를 불러오는 중")}</div>
      : loadError ? <div className="project-data-state error"><AlertTriangle size={15} />{t("연결 데이터를 불러오지 못했습니다.")}</div>
      : connection ? <>
        <div className="project-data-summary">
          <div><small>{t("데이터 소스")}</small><b><Link2 size={12} />{connection.name}</b></div>
          <div><small>{t("현재 / 목표")}</small><b>{formatProjectDataMetric(connection.lastValue, connection.unit)} <em>/ {formatProjectDataMetric(connection.targetValue, connection.unit)}</em></b></div>
          <div><small>{t("갱신")}</small><b>{projectDataCadenceLabel(connection.cadence)} · {connection.active ? t("활성") : t("일시정지")}</b></div>
          <div><small>{t("최근 결과")}</small><b className={`sync-${connection.lastSyncStatus}`}>{projectDataSyncLabel(connection)}</b></div>
        </div>
        <div className="project-data-progress"><span><i style={{ width: `${project.progress}%` }} /></span><b>{project.progress}%</b></div>
        {connection.lastError && <p className="kr-data-error"><AlertTriangle size={13} />{t("최근 데이터 갱신에 실패했습니다. 연결 설정을 확인해 주세요.")}</p>}
      </> : <div className="project-data-state"><Database size={15} />{t("데이터 화면에서 이 Project에 API를 연결할 수 있습니다.")}</div>}
  </section>;
}

function formatProjectDataMetric(value: number | null, unit: string) {
  return value === null ? t("아직 값 없음") : `${new Intl.NumberFormat(getClientLocale(), { maximumFractionDigits: 2 }).format(value)}${unit}`;
}

function projectDataCadenceLabel(cadence: ProjectDataConnection["cadence"]) {
  return t({ hourly: "매시간", daily: "매일", weekly: "매주", manual: "수동만" }[cadence]);
}

function projectDataSyncLabel(connection: ProjectDataConnection) {
  if (connection.lastSyncStatus === "never") return t("업데이트 전");
  if (connection.lastSyncStatus === "error") return t("오류");
  return connection.lastSyncedAt ? new Date(connection.lastSyncedAt).toLocaleString(getClientLocale(), { dateStyle: "short", timeStyle: "short" }) : t("완료");
}

function ProjectSystemPropertySlot({ property, readOnly, onHide, children }: { property?: PropertyDefinition; readOnly: boolean; onHide: (propertyId: string, hidden: boolean) => void; children: ReactNode }) {
  return <div className="project-system-property">{children}{property && !readOnly && <button type="button" className="icon-button" onClick={() => onHide(property.id, true)} aria-label={t("{value1} 숨기기", { value1: messageValue(systemPropertyLabel(property, t)) })} title={t("이 Project에서 숨기기")}><EyeOff size={13} /></button>}</div>;
}

type ProjectBlockEditorProps = import("@/app/project-block-editor").ProjectBlockEditorProps;

function ClientProjectBlockEditor(props: ProjectBlockEditorProps) {
  const [Editor, setEditor] = useState<ComponentType<ProjectBlockEditorProps> | null>(null);
  useEffect(() => {
    let active = true;
    void import("@/app/project-block-editor").then((module) => { if (active) setEditor(() => module.default); });
    return () => { active = false; };
  }, []);
  return Editor ? <Editor {...props} /> : <div className="project-editor-loading"><LoaderCircle size={16} />{t("편집기를 불러오는 중")}</div>;
}

function ProjectDocumentSection({ projectId, readOnly, onNotice }: { projectId: string; readOnly: boolean; onNotice: (message: string) => void }) {
  const [editing, setEditing] = useState(false);
  const [editorRevision, setEditorRevision] = useState(0);
  const [uploadBusy, setUploadBusy] = useState(false);
  const [draftPending, setDraftPending] = useState(false);
  const [templateBusy, setTemplateBusy] = useState(false);
  const [document, setDocument] = useState<ProjectDocument | null>(null);
  const [templates, setTemplates] = useState<ProjectTemplate[]>([]);
  const [templateId, setTemplateId] = useState("");
  const [templateName, setTemplateName] = useState("");
  const [creatingTemplate, setCreatingTemplate] = useState(false);
  const [loading, setLoading] = useState(true);
  const [savingState, setSavingState] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const versionRef = useRef(0);
  const savingRef = useRef(false);
  const pendingChangeRef = useRef<ProjectBlockEditorChange | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    void Promise.all([
      fetch(`/api/project-documents?projectId=${encodeURIComponent(projectId)}`, { signal: controller.signal }).then(async (response) => response.ok ? response.json() as Promise<{ document: ProjectDocument }> : Promise.reject()),
      fetch("/api/project-templates", { signal: controller.signal }).then(async (response) => response.ok ? response.json() as Promise<{ templates: ProjectTemplate[] }> : Promise.reject()),
    ]).then(([documentData, templateData]) => {
      versionRef.current = documentData.document.version;
      setDocument(documentData.document);
      setTemplates(templateData.templates);
    }).catch((error: unknown) => {
      if (!(error instanceof DOMException && error.name === "AbortError")) setSavingState("error");
    }).finally(() => setLoading(false));
    return () => controller.abort();
  }, [projectId]);

  async function flushDocumentSave() {
    if (savingRef.current || !pendingChangeRef.current) return;
    savingRef.current = true;
    const change = pendingChangeRef.current;
    pendingChangeRef.current = null;
    setSavingState("saving");
    let saved = false;
    try {
      const response = await fetch("/api/project-documents", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ projectId, ...change, expectedVersion: versionRef.current }),
      });
      const data = await response.json().catch(() => ({})) as { document?: ProjectDocument };
      if (!response.ok || !data.document) {
        if (!pendingChangeRef.current) pendingChangeRef.current = change;
        setSavingState("error");
        if (response.status === 409) onNotice(t("다른 변경이 먼저 저장되었습니다. 문서를 다시 불러와 주세요."));
        return;
      }
      versionRef.current = data.document.version;
      setDocument(data.document);
      setSavingState("saved");
      saved = true;
      window.setTimeout(() => setSavingState((current) => current === "saved" ? "idle" : current), 1600);
    } catch {
      if (!pendingChangeRef.current) pendingChangeRef.current = change;
      setSavingState("error");
    } finally {
      savingRef.current = false;
      if (pendingChangeRef.current && saved) void flushDocumentSave();
    }
  }

  function queueDocumentSave(change: ProjectBlockEditorChange) {
    pendingChangeRef.current = change;
    void flushDocumentSave();
  }

  async function applyTemplate() {
    if (!templateId || readOnly || templateBusy || uploadBusy || draftPending || savingRef.current || pendingChangeRef.current) return;
    const selected = templates.find((template) => template.id === templateId);
    setTemplateBusy(true);
    try {
    const response = await fetch("/api/project-documents", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ projectId, templateId }),
    });
    const data = await response.json() as { document?: ProjectDocument };
    if (!response.ok || !data.document) { onNotice(t("템플릿을 불러오지 못했습니다.")); return; }
    versionRef.current = data.document.version;
    setDocument(data.document);
    setEditorRevision(value => value + 1);
    setTemplateId("");
    onNotice(t("'{value1}'을 기존 내용 위에 추가했습니다.", { value1: messageValue(selected?.name ?? "템플릿") }));
    } catch { onNotice(t("템플릿을 불러오지 못했습니다.")); }
    finally { setTemplateBusy(false); }
  }

  async function createTemplateFromDocument(event: FormEvent) {
    event.preventDefault();
    if (!document || readOnly || templateBusy || uploadBusy || draftPending || savingRef.current || pendingChangeRef.current) return;
    const name = templateName.trim();
    if (!name) return;
    setTemplateBusy(true);
    try {
    const response = await fetch("/api/project-templates", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, content: document.content, plainText: document.plainText }),
    });
    const data = await response.json() as { template?: ProjectTemplate; error?: string };
    if (!response.ok || !data.template) { onNotice(apiError(data, "템플릿을 만들지 못했습니다.")); return; }
    setTemplates((current) => [data.template!, ...current]);
    setTemplateName("");
    setCreatingTemplate(false);
    onNotice(t("현재 문서를 템플릿으로 저장했습니다."));
    } catch { onNotice(t("템플릿을 만들지 못했습니다.")); }
    finally { setTemplateBusy(false); }
  }

  return <section className="project-document-section">
    <header><div><b>{t("프로젝트 문서")}</b>{(editing || savingState !== "idle") && <span>{savingState === "saving" ? t("저장 중") : savingState === "saved" ? t("저장됨") : savingState === "error" ? t("저장 실패") : t("자동 저장")}</span>}</div>{!readOnly && <button type="button" className="secondary" disabled={loading || !document || uploadBusy || templateBusy} aria-pressed={editing} onClick={() => { setEditing(value => !value); setCreatingTemplate(false); }}>{editing ? t("닫기") : t("변경")}</button>}</header>
    {!readOnly && savingState === "error" && document && <div className="document-save-error"><span role="alert">{t("저장 실패")}</span><button className="secondary" onClick={() => void flushDocumentSave()}>{t("재시도")}</button></div>}
    {!readOnly && editing && <div className="project-document-actions document-template-tools"><select value={templateId} disabled={templateBusy} onChange={(event) => setTemplateId(event.target.value)} aria-label={t("본문 템플릿 선택")}><option value="">{t("템플릿 불러오기")}</option>{templates.map((template) => <option value={template.id} key={template.id}>{template.name}</option>)}</select><button className="secondary" disabled={!templateId || templateBusy || uploadBusy || draftPending || savingState === "saving" || savingState === "error"} aria-busy={templateBusy} onClick={() => void applyTemplate()}><BookTemplate size={16} />{t("불러오기")}</button><button className="secondary" disabled={templateBusy || uploadBusy || draftPending || savingState === "saving" || savingState === "error"} onClick={() => setCreatingTemplate(true)}><Copy size={16} />{t("템플릿으로 저장")}</button></div>}
    {creatingTemplate && <form className="project-document-template-create" onSubmit={(event) => void createTemplateFromDocument(event)}><input aria-label={t("새 템플릿 이름")} value={templateName} onChange={(event) => setTemplateName(event.target.value)} placeholder={t("템플릿 이름")} /><button disabled={!templateName.trim()}><Check size={13} />{t("저장")}</button><button type="button" className="icon-button" aria-label={t("템플릿 만들기 취소")} onClick={() => { setCreatingTemplate(false); setTemplateName(""); }}><X size={13} /></button></form>}
    {loading ? <div className="project-editor-loading"><LoaderCircle size={16} />{t("문서를 불러오는 중")}</div> : document ? <ClientProjectBlockEditor key={`${projectId}:${editorRevision}`} initialContent={document.content} editable={!readOnly && editing && !templateBusy} imageTarget={{ targetKind: "project", targetId: projectId }} onUploadBusyChange={setUploadBusy} onPendingChange={setDraftPending} onChange={readOnly || templateBusy ? undefined : queueDocumentSave} /> : <div className="project-editor-error">{t("문서를 불러오지 못했습니다.")}</div>}
  </section>;
}

function WorkDocumentSection({ targetKind, targetId, readOnly, onNotice }: { targetKind: "task" | "routine"; targetId: string; readOnly: boolean; onNotice: (message: string) => void }) {
  const [editing, setEditing] = useState(false);
  const [uploadBusy, setUploadBusy] = useState(false);
  const [document, setDocument] = useState<WorkDocument | null>(null);
  const [loading, setLoading] = useState(true);
  const [savingState, setSavingState] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const versionRef = useRef(0);
  const savingRef = useRef(false);
  const pendingChangeRef = useRef<ProjectBlockEditorChange | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    let active = true;
    const query = new URLSearchParams({ targetKind, targetId });
    void fetch(`/api/work-documents?${query}`, { signal: controller.signal })
      .then(async (response) => response.ok ? response.json() as Promise<{ document: WorkDocument }> : Promise.reject())
      .then((data) => {
        if (!active) return;
        versionRef.current = data.document.version;
        setDocument(data.document);
      })
      .catch((error: unknown) => {
        if (active && !(error instanceof DOMException && error.name === "AbortError")) setSavingState("error");
      })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; controller.abort(); };
  }, [targetId, targetKind]);

  async function flushDocumentSave() {
    if (savingRef.current || !pendingChangeRef.current) return;
    savingRef.current = true;
    const change = pendingChangeRef.current;
    pendingChangeRef.current = null;
    setSavingState("saving");
    let saved = false;
    try {
      const response = await fetch("/api/work-documents", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ targetKind, targetId, ...change, expectedVersion: versionRef.current }),
      });
      const data = await response.json().catch(() => ({})) as { document?: WorkDocument };
      if (!response.ok || !data.document) {
        if (!pendingChangeRef.current) pendingChangeRef.current = change;
        setSavingState("error");
        if (response.status === 409) onNotice(t("다른 변경이 먼저 저장되었습니다. 문서를 다시 불러와 주세요."));
        return;
      }
      versionRef.current = data.document.version;
      setDocument(data.document);
      setSavingState("saved");
      saved = true;
      window.setTimeout(() => setSavingState((current) => current === "saved" ? "idle" : current), 1600);
    } catch {
      if (!pendingChangeRef.current) pendingChangeRef.current = change;
      setSavingState("error");
    } finally {
      savingRef.current = false;
      if (pendingChangeRef.current && saved) void flushDocumentSave();
    }
  }

  function queueDocumentSave(change: ProjectBlockEditorChange) {
    pendingChangeRef.current = change;
    void flushDocumentSave();
  }

  const title = targetKind === "task" ? t("Task 문서") : t("Routine 문서");
  return <section className="project-document-section work-document-section">
    <header><div><b>{title}</b>{(editing || savingState !== "idle") && <span>{savingState === "saving" ? t("저장 중") : savingState === "saved" ? t("저장됨") : savingState === "error" ? t("저장 실패") : t("자동 저장")}</span>}</div>{!readOnly && <button type="button" className="secondary" disabled={loading || !document || uploadBusy} aria-pressed={editing} onClick={() => setEditing(value => !value)}>{editing ? t("닫기") : t("변경")}</button>}</header>
    {!readOnly && savingState === "error" && document && <div className="document-save-error"><span role="alert">{t("저장 실패")}</span><button className="secondary" onClick={() => void flushDocumentSave()}>{t("재시도")}</button></div>}
    {loading ? <div className="project-editor-loading"><LoaderCircle size={16} />{t("문서를 불러오는 중")}</div> : document ? <ClientProjectBlockEditor key={`${targetKind}:${targetId}`} initialContent={document.content} editable={!readOnly && editing} imageTarget={{ targetKind, targetId }} onUploadBusyChange={setUploadBusy} onChange={readOnly ? undefined : queueDocumentSave} /> : <div className="project-editor-error">{t("문서를 불러오지 못했습니다.")}</div>}
  </section>;
}

function ProjectPropertyField({ projectId, property, value, members, readOnly, onChange, onHide }: { projectId: string; property: PropertyDefinition; value: PropertyValue; members: TeamMember[]; readOnly: boolean; onChange: (itemId: string, propertyId: string, value: PropertyValue) => Promise<void>; onHide: () => void }) {
  const memberIds = Array.isArray(value) ? value : typeof value === "string" ? [value] : [];
  const inputValue = property.type === "member" ? memberIds[0] ?? null : property.type === "members" ? memberIds : value;
  return (
    <div className="project-property-field-row">
      <label className="project-property-field">
        <span>{systemPropertyLabel(property, t)}</span>
        <PropertyValueInput type={property.type} value={inputValue} options={property.options} members={members} disabled={readOnly} onChange={(next) => {
          const normalized = property.type === "number" ? (next === "" || next === null ? null : Number(next)) : next === "" ? null : next;
          void onChange(projectId, property.id, normalized);
        }} />
      </label>
      {!readOnly && <button type="button" className="icon-button" onClick={onHide} aria-label={t("{value1} 숨기기", { value1: messageValue(systemPropertyLabel(property, t)) })} title={t("이 Project에서 숨기기")}><EyeOff size={14} /></button>}
    </div>
  );
}

function TaskDetailPanel({ task, readOnly, allItems, routines, teamMembers, onClose, onOpenParent, onPatch, onAssignmentsChange, onNotice, canDelete, selected, onToggleSelect }: {
  task: OkriItem;
  readOnly: boolean;
  onOpenParent: (kind: "project" | "routine", id: string) => void;
  allItems: OkriItem[];
  routines: Routine[];
  teamMembers: TeamMember[];
  onClose: () => void;
  onPatch: (patch: Partial<OkriItem>) => Promise<unknown>;
  onAssignmentsChange: (assignments: ItemAssignment[]) => void;
  onNotice: (message: string) => void;
  canDelete: boolean;
  selected: boolean;
  onToggleSelect: () => void;
}) {
  const confirmAction = useAppConfirm();
  const [rows, setRows] = useState<ChecklistItem[]>([]);
  const [title, setTitle] = useState("");
  const [syncingCalendar, setSyncingCalendar] = useState(false);
  const [savingChecklist, setSavingChecklist] = useState(false);
  const [checklistLoadError, setChecklistLoadError] = useState(false);
  const byId = new Map(allItems.map((entry) => [entry.id, entry]));
  const project = task.parentId ? byId.get(task.parentId) : undefined;
  const projects = allItems.filter((entry) => entry.kind === "project" && !entry.archivedAt);
  const initiative = project?.parentId ? byId.get(project.parentId) : undefined;
  const keyResult = initiative?.parentId ? byId.get(initiative.parentId) : undefined;
  const objective = keyResult?.parentId ? byId.get(keyResult.parentId) : undefined;
  const routineMatch = task.routineId ? routines.find((entry) => entry.id === task.routineId) : undefined;
  const routine = routineMatch?.active && routineMatch.systemKey !== "general" ? routineMatch : undefined;
  const projectDri = project ? assignmentLabel(project, "project_dri") : "미지정";
  const assigneeIds = task.assignments.filter((entry) => entry.role === "task_assignee").map((entry) => entry.memberId);
  const taskContainerValue = project?.kind === "project" ? `project:${project.id}` : routine ? `routine:${routine.id}` : "";
  const lineageTitle = routine ? `Routine · ${routine.title}` : project?.kind === "project" ? `Project · ${project.title}` : routineMatch?.systemKey === "general" ? "General 수집함" : "연결 끊김";
  const propertyEntries: DocumentProperty[] = [
    { key: "status", label: t("상태"), value: statusLabels[task.status], primary: true },
    { key: "assignee", label: t("담당자"), value: assignmentLabel(task, "task_assignee"), primary: true },
    { key: "due", label: t("기한"), value: dueLabel(task.dueDate), primary: true },
    { key: "priority", label: t("우선순위"), value: priorityLabels[task.priority] },
    { key: "parent", label: t("연결 대상"), value: lineageTitle },
  ];
  useEffect(() => {
    fetch(`/api/checklists?taskId=${encodeURIComponent(task.id)}`)
      .then(async (response) => response.ok ? response.json() as Promise<{ items: ChecklistItem[] }> : Promise.reject())
      .then((data) => { setRows(data.items); setChecklistLoadError(false); })
      .catch(() => { setRows([]); setChecklistLoadError(true); onNotice(t("체크리스트를 불러오지 못했습니다.")); });
  }, [onNotice, task.id]);

  async function saveAssignee(memberIds: string[]) {
    const response = await fetch("/api/item-assignments", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ itemId: task.id, role: "task_assignee", memberIds }),
    });
    if (!response.ok) {
      onNotice(t("담당자를 저장하지 못했습니다."));
      return;
    }
    const data = await response.json() as { assignments: ItemAssignment[] };
    onAssignmentsChange(data.assignments);
  }

  function saveContainer(value: string) {
    const [kind, id] = value.split(":", 2);
    if (!id) {
      void onPatch({ parentId: null, routineId: null, cycleId: null });
      return;
    }
    if (kind === "project") {
      const nextProject = projects.find((entry) => entry.id === id);
      if (nextProject) void onPatch({ parentId: nextProject.id, routineId: null, cycleId: nextProject.cycleId });
    } else if (kind === "routine" && routines.some((entry) => entry.id === id && entry.active && entry.systemKey !== "general")) {
      void onPatch({ parentId: null, routineId: id, cycleId: null });
    }
  }

  async function addRow(event: FormEvent) {
    event.preventDefault();
    const nextTitle = title.trim();
    if (!nextTitle || savingChecklist) return;
    setSavingChecklist(true);
    const response = await fetch("/api/checklists", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ taskId: task.id, title: nextTitle }) });
    setSavingChecklist(false);
    if (!response.ok) { onNotice(t("체크리스트를 추가하지 못했습니다.")); return; }
    const data = await response.json() as { item: ChecklistItem };
    setRows((current) => {
      const next = [...current, data.item];
      return next;
    });
    setTitle("");
  }

  async function toggleRow(row: ChecklistItem) {
    const completed = !row.completed;
    const previous = rows;
    const next = rows.map((entry) => entry.id === row.id ? { ...entry, completed } : entry);
    setRows(next);
    const response = await fetch("/api/checklists", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id: row.id, completed }) });
    if (!response.ok) { setRows(previous); onNotice(t("체크리스트 변경을 저장하지 못했습니다.")); }
  }

  async function deleteRow(id: string) {
    const row = rows.find((entry) => entry.id === id);
    if (!row || !await confirmAction({ title: t("체크리스트 삭제"), message: t("'{value1}' 항목을 삭제합니다.", { value1: messageValue(row.title) }), confirmLabel: t("삭제"), danger: true })) return;
    const previous = rows;
    const next = rows.filter((entry) => entry.id !== id);
    setRows(next);
    const response = await fetch(`/api/checklists?id=${encodeURIComponent(id)}`, { method: "DELETE" });
    if (!response.ok) { setRows(previous); onNotice(t("체크리스트를 삭제하지 못했습니다.")); }
  }

  async function syncCalendar() {
    if (!task.dueDate) {
      onNotice(t("기한이 있는 Task만 Google Calendar로 보낼 수 있습니다."));
      return;
    }
    setSyncingCalendar(true);
    try {
      const response = await fetch("/api/google/calendar-event", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ itemId: task.id }),
      });
      const data = await response.json() as { event?: { htmlLink?: string }; code?: string; error?: string };
      if (!response.ok) {
        if (data.code === "google_not_connected") onNotice(t("먼저 연동에서 Google Calendar를 연결해 주세요."));
        else if (data.code === "missing_google_config") onNotice(t("Google OAuth 설정이 아직 필요합니다."));
        else onNotice(apiError(data, "Google Calendar 동기화에 실패했습니다."));
        return;
      }
      onNotice(t("Google Calendar에 반영했습니다."));
      if (data.event?.htmlLink) window.open(data.event.htmlLink, "_blank", "noopener,noreferrer");
    } finally {
      setSyncingCalendar(false);
    }
  }

  return (
    <OverlayDialog title={t("{value1} Task 상세", { value1: messageValue(task.title) })} variant="drawer" dirty={Boolean(title.trim())} history={false} onRequestClose={() => onClose()}>
      {(requestClose) => <aside className="property-panel task-detail-panel">
        <header><div>{project?.kind === "project" || routine ? <button type="button" className="detail-parent-link" onClick={async () => { if (title.trim() && !await confirmAction({ title: t("변경사항을 버릴까요?"), message: t("저장하지 않은 변경사항이 있습니다. 닫으면 작성한 내용이 사라집니다."), confirmLabel: t("변경사항 버리기"), danger: true })) return; if (project?.kind === "project") onOpenParent("project", project.id); else if (routine) onOpenParent("routine", routine.id); }}><ArrowLeft size={14} />{lineageTitle}</button> : <p>{lineageTitle}</p>}<h2 className="document-title">{task.title}</h2></div><div className="task-detail-actions">{canDelete && <DeleteSelectCheckbox item={task} selected={selected} onToggle={onToggleSelect} />}<button className="icon-button" onClick={() => requestClose("close-button")} aria-label={t("닫기")}><X size={17} /></button></div></header>
        <DocumentProperties entries={propertyEntries} readOnly={readOnly}>{() => <>
        <div className="property-form"><label><span>{t("Task 이름")}</span><textarea aria-label={t("Task 이름")} defaultValue={task.title} rows={2} onBlur={(event) => { const nextTitle = event.currentTarget.value.trim(); if (nextTitle && nextTitle !== task.title) void onPatch({ title: nextTitle }); }} /></label></div>
        <section className="task-detail-fields" aria-label={t("Task 정보")}>
          <label><span>{t("우선순위")}</span><select className={`priority-${task.priority}`} value={task.priority} onChange={(event) => void onPatch({ priority: event.target.value as Priority })}>{Object.entries(priorityLabels).map(([value, label]) => <option value={value} key={value}>{label}</option>)}</select></label>
          <label><span>{t("기한")}</span><input type="date" value={task.dueDate ?? ""} onChange={(event) => void onPatch({ dueDate: event.target.value || null })} /></label>
          <label className="task-container-field"><span>{t("연결 대상")}</span><select value={taskContainerValue} onChange={(event) => saveContainer(event.target.value)}><option value="">General</option><optgroup label={t("Project")}>{projects.map((entry) => <option value={`project:${entry.id}`} key={entry.id}>{entry.title}</option>)}</optgroup><optgroup label={t("Routine")}>{routines.filter((entry) => entry.active && entry.systemKey !== "general").map((entry) => <option value={`routine:${entry.id}`} key={entry.id}>{entry.title}</option>)}</optgroup></select></label>
        </section>
        {teamMembers.length > 0 && <section className="task-assignee-editor"><MemberMentionPicker label={t("담당자")} members={teamMembers} selectedIds={assigneeIds} onChange={(ids) => void saveAssignee(ids)} placeholder={t("@실명으로 찾기")} maxSelected={1} /></section>}
        </>}</DocumentProperties>
        <div className="task-work-actions">
          <button type="button" disabled={readOnly} className={`task-completion-toggle ${isCompletedStatus(task.status) ? "completed" : ""}`} aria-pressed={isCompletedStatus(task.status)} onClick={() => void onPatch(taskCompletionPatch(task.status))}><span><Check size={14} /></span>{isCompletedStatus(task.status) ? t("완료 취소") : t("완료")}</button>
          <LocalAgentLauncher targetKind="task" targetId={task.id} targetTitle={task.title} readOnly={readOnly} onNotice={onNotice} />
        </div>
        <details className="document-related"><summary>{t("상위 맵핑")} · Google Calendar</summary>
        <section className="task-lineage">
          <header><b>{t("상위 맵핑")}</b><span>{routine ? t("Routine 기반 Task") : project ? t("OKR 실행 구조") : t("아직 연결 전")}</span></header>
          <LineageRow label={t("등록 경로")} value={sourceLabel(task.source)} />
          {routine ? (
            <>
              <LineageRow label={t("Routine")} value={routine.title} />
              <LineageRow label={t("트리거")} value={routine.triggerPoint || t("미지정")} />
              <LineageRow label={t("어디서/어떻게")} value={[routine.actionPlace, routine.actionSteps].filter(Boolean).join(" · ") || t("미지정")} />
            </>
          ) : (
            <>
              <LineageRow label={t("Objective")} value={objective?.title ?? "미연결"} />
              <LineageRow label={t("Key Result")} value={keyResult?.title ?? "미연결"} />
              <LineageRow label={t("Initiative")} value={initiative?.title ?? "미연결"} />
              <LineageRow label={t("Project")} value={project?.title ?? "미연결"} />
              {project && <div className="lineage-project-meta"><span>{t("우선순위")}<b>{priorityLabels[project.priority]}</b></span><span>{t("책임자")}<b>{projectDri}</b></span><span>{t("상태")}<b>{statusLabel(project.status)}</b></span><span>{t("기한")}<b>{dueLabel(project.dueDate)}</b></span></div>}
            </>
          )}
        </section>
        <div className="task-calendar-action"><button onClick={() => void syncCalendar()} disabled={readOnly || syncingCalendar || !task.dueDate}><CalendarDays size={13} />{syncingCalendar ? t("동기화 중") : t("Google Calendar에 보내기")}</button></div>
        </details>
        <WorkDocumentSection key={`task-document:${task.id}`} targetKind="task" targetId={task.id} readOnly={readOnly} onNotice={onNotice} />
        <section className="checklist-section"><header><b>{t("체크리스트")}</b><span>{rows.filter((entry) => entry.completed).length}/{rows.length}</span></header>{checklistLoadError && <p className="inline-error" role="alert">{t("체크리스트를 불러오지 못했습니다. 상세 화면을 다시 열어 재시도해 주세요.")}</p>}<div>{rows.map((row) => <div className="checklist-row" key={row.id}><button className={`task-check ${row.completed ? "checked" : ""}`} onClick={() => void toggleRow(row)} aria-label={`${row.title} ${row.completed ? t("완료 취소") : t("완료")}`}><Check size={12} /></button><span className={row.completed ? "completed" : ""}>{row.title}</span><button className="icon-button" onClick={() => void deleteRow(row.id)} aria-label={t("{value1} 삭제", { value1: messageValue(row.title) })}><Trash2 size={13} /></button></div>)}</div><form className="checklist-form" onSubmit={addRow}><Plus size={14} /><input value={title} onChange={(event) => setTitle(event.target.value)} placeholder={t("항목 추가")} aria-label={t("체크리스트 항목")} disabled={savingChecklist} /><button disabled={!title.trim() || savingChecklist}>{savingChecklist ? t("추가 중") : t("추가")}</button></form></section>
      </aside>}
    </OverlayDialog>
  );
}

function LineageRow({ label, value }: { label: string; value: string }) {
  return <div className="lineage-row"><span>{label}</span><b>{value}</b></div>;
}

function memberInitial(member: Pick<TeamMember, "displayName" | "email">) {
  return (member.displayName || member.email || "?").slice(0, 1).toLocaleUpperCase();
}

function memberNameNeedsConfirmation(member: Pick<TeamMember, "displayName" | "email">) {
  const name = member.displayName.trim();
  if (!name || name === "Member" || /^\S+@\S+\.\S+$/.test(name)) return true;
  const emailName = member.email.split("@")[0]?.trim();
  return Boolean(emailName && name.toLocaleLowerCase() === emailName.toLocaleLowerCase());
}

function profileNameConfirmationKey(member: Pick<TeamMember, "id">) {
  return `okri.profile-name-confirmed.${member.id}`;
}

function matchesMember(member: TeamMember, query: string) {
  const normalized = query.replace(/^@/, "").trim().toLocaleLowerCase();
  if (!normalized) return true;
  return `${member.displayName} ${member.email}`.toLocaleLowerCase().includes(normalized);
}

function pickMembers(members: TeamMember[], ids: string[]) {
  const byId = new Map(members.map((member) => [member.id, member]));
  return ids.map((id) => byId.get(id)).filter((member): member is TeamMember => Boolean(member));
}

function assignmentLabel(item: OkriItem, role: ItemAssignmentRole) {
  const names = item.assignments.filter((entry) => entry.role === role).map((entry) => `@${entry.displayName}`);
  return names.length ? names.join(", ") : "미지정";
}

function canUserDeleteItem(item: OkriItem, currentMember: TeamMember | undefined, userId: string | null) {
  if (currentMember?.role === "viewer") return false;
  if (userId && item.createdByUserId === userId) return true;
  if (!currentMember) return false;
  const accountableRole: ItemAssignmentRole | null = item.kind === "project"
    ? "project_dri"
    : item.kind === "task" ? "task_assignee" : null;
  return Boolean(accountableRole && item.assignments.some((assignment) =>
    assignment.memberId === currentMember.id && assignment.role === accountableRole,
  ));
}

function MemberMentionPicker({
  label,
  members,
  selectedIds,
  onChange,
  placeholder,
  maxSelected,
  disabled = false,
}: {
  label: string;
  members: TeamMember[];
  selectedIds: string[];
  onChange: (ids: string[]) => void;
  placeholder: string;
  maxSelected?: number;
  disabled?: boolean;
}) {
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const fieldRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const pickerId = useId().replace(/:/g, "");
  const selectedMembers = pickMembers(members, selectedIds);
  const selectedSet = new Set(selectedIds);
  const candidates = members
    .filter((member) => !selectedSet.has(member.id) && matchesMember(member, query))
    .slice(0, 7);
  const atLimit = typeof maxSelected === "number" && selectedIds.length >= maxSelected;

  function add(id: string) {
    if (disabled || selectedSet.has(id)) return;
    onChange(maxSelected === 1 ? [id] : [...selectedIds, id]);
    setQuery("");
    setOpen(false);
  }

  function remove(id: string) {
    if (disabled) return;
    onChange(selectedIds.filter((entry) => entry !== id));
  }

  function handleKeyDown(event: ReactKeyboardEvent<HTMLInputElement>) {
    if (event.key === "Escape") {
      event.preventDefault();
      setOpen(false);
      return;
    }
    if (event.key === "Enter" && candidates[0] && !atLimit) {
      event.preventDefault();
      add(candidates[0].id);
      return;
    }
    if (event.key === "Backspace" && !query && selectedIds.length) {
      onChange(selectedIds.slice(0, -1));
    }
  }

  useEffect(() => {
    if (!open) return;
    function closeOnOutside(event: PointerEvent) {
      if (!fieldRef.current?.contains(event.target as Node)) setOpen(false);
    }
    window.addEventListener("pointerdown", closeOnOutside);
    return () => window.removeEventListener("pointerdown", closeOnOutside);
  }, [open]);

  return (
    <div className="member-mention-field" ref={fieldRef}>
      <span id={`${pickerId}-label`}>{label}</span>
      <div className={`member-mention-box ${open ? "active" : ""} ${disabled ? "disabled" : ""}`}>
        {selectedMembers.map((member) => (
          <button type="button" className="member-chip" key={member.id} onClick={() => remove(member.id)} disabled={disabled} title={t("{value1} 제거", { value1: messageValue(member.displayName) })}>
            <span className="team-avatar">{memberInitial(member)}</span>
            <b>@{member.displayName}</b>
            <X size={11} />
          </button>
        ))}
        {!atLimit && (
          <div className="member-mention-input">
            <AtSign size={13} />
            <input
              ref={inputRef}
              value={query}
              onChange={(event) => { setQuery(event.target.value); setOpen(true); }}
              onFocus={() => setOpen(true)}
              onKeyDown={handleKeyDown}
              placeholder={selectedMembers.length ? "" : placeholder}
              disabled={disabled}
              role="combobox"
              aria-labelledby={`${pickerId}-label`}
              aria-controls={`${pickerId}-listbox`}
              aria-expanded={open && !atLimit}
              aria-autocomplete="list"
            />
          </div>
        )}
      </div>
      {open && !disabled && !atLimit && (
        <div className="member-mention-menu" id={`${pickerId}-listbox`} role="listbox" aria-label={t("{value1} 후보", { value1: messageValue(label) })}>
          {candidates.length ? candidates.map((member) => (
            <button type="button" role="option" aria-selected="false" key={member.id} onClick={() => add(member.id)}>
              <span className="team-avatar">{memberInitial(member)}</span>
              <b>{member.displayName}</b>
              <small>{member.email || teamRoleLabel(member.role)}</small>
            </button>
          )) : <p>{t("일치하는 멤버가 없습니다")}</p>}
        </div>
      )}
    </div>
  );
}

function CreateItemPanel({ initialKind, cycleId, items, routines, properties, teamMembers, onClose, onCreated, onCreateWithChat }: {
  initialKind: ItemKind;
  cycleId: string | null;
  items: OkriItem[];
  routines: Routine[];
  properties: PropertyDefinition[];
  teamMembers: TeamMember[];
  onClose: () => void;
  onCreated: (item: OkriItem, initialValues?: Record<string, PropertyValue>, warning?: string) => void;
  onCreateWithChat?: (draft: { kind: ItemKind; title: string }) => void;
}) {
  const kind = initialKind;
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [parentId, setParentId] = useState("");
  const [taskContainer, setTaskContainer] = useState("");
  const [status, setStatus] = useState<ItemStatus>(() => propertySystemDefault(properties, "status", "todo") as ItemStatus);
  const [priority, setPriority] = useState<Priority>(() => propertySystemDefault(properties, "priority", "medium") as Priority);
  const [cadence] = useState<Cadence>(() => propertySystemDefault(properties, "cadence", "weekly") as Cadence);
  const [dueDate, setDueDate] = useState(() => propertySystemDefault(properties, "due_date", ""));
  const [customValues, setCustomValues] = useState<Record<string, PropertyValue>>({});
  const [availableTemplates, setAvailableTemplates] = useState<ProjectTemplate[]>([]);
  const [templateId, setTemplateId] = useState("");
  const currentMemberId = teamMembers.find((member) => member.isCurrent && member.status === "active")?.id;
  const [projectDriIds, setProjectDriIds] = useState<string[]>(() => { const value = properties.find((property) => property.systemKey === "project_dri")?.defaultValue; return typeof value === "string" ? [value] : currentMemberId ? [currentMemberId] : []; });
  const [projectWorkerIds, setProjectWorkerIds] = useState<string[]>(() => { const value = properties.find((property) => property.systemKey === "project_workers")?.defaultValue; return Array.isArray(value) ? value : []; });
  const [taskAssigneeIds, setTaskAssigneeIds] = useState<string[]>(currentMemberId ? [currentMemberId] : []);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const requiredParent: Record<ItemKind, ItemKind | null> = { objective: null, key_result: "objective", initiative: "key_result", project: "initiative", task: "project" };
  const parentKind = requiredParent[kind];
  const parentOptions = parentKind ? items.filter((entry) => entry.kind === parentKind && (!cycleId || entry.cycleId === cycleId)) : [];
  const taskProjectOptions = items.filter((entry) => entry.kind === "project" && !entry.archivedAt);
  const taskRoutineOptions = routines.filter((entry) => entry.active && entry.systemKey !== "general");
  const hasTaskContainerOptions = taskProjectOptions.length > 0 || taskRoutineOptions.length > 0;
  const projectProperties = kind === "project" ? properties.filter((property) => property.active && !property.systemKey) : [];
  const dirty = Boolean(title.trim() || description.trim() || parentId || taskContainer || templateId || Object.keys(customValues).length);

  useEffect(() => {
    if (kind !== "project") return;
    let active = true;
    void fetch("/api/project-templates").then(async (response) => response.ok ? response.json() as Promise<{ templates: ProjectTemplate[] }> : Promise.reject()).then((data) => { if (active) setAvailableTemplates(data.templates); }).catch(() => undefined);
    return () => { active = false; };
  }, [kind]);

  function updateCustomValue(property: PropertyDefinition, value: PropertyValue) {
    setCustomValues((current) => ({
      ...current,
      [property.id]: property.type === "number"
        ? (value === "" || value === null ? null : Number(value))
        : value === "" ? null : value,
    }));
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!title.trim() || saving || (kind !== "task" && kind !== "objective" && !parentId)) return;
    setSaving(true);
    setError("");
    const routineId = kind === "task" && taskContainer.startsWith("routine:") ? taskContainer.slice(8) : null;
    const taskParentId = kind === "task" && taskContainer.startsWith("project:") ? taskContainer.slice(8) : null;
    const nextParentId = kind === "task" ? taskParentId : parentId || null;
    const nextDescription = kind === "project" ? description.trim() : "";
    try {
      const response = await fetch("/api/items", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title,
          kind,
          cycleId: kind === "task" && (!nextParentId || routineId) ? null : cycleId,
          description: nextDescription,
          parentId: nextParentId,
          routineId,
          status: kind === "task" ? "todo" : status,
          priority,
          cadence: kind === "project" ? undefined : cadence,
          dueDate: dueDate || null,
          driMemberId: kind === "project" ? projectDriIds[0] ?? "" : undefined,
          workerMemberIds: kind === "project" ? projectWorkerIds : undefined,
          assigneeMemberId: kind === "task" ? taskAssigneeIds[0] ?? "" : undefined,
          templateId: kind === "project" ? templateId || undefined : undefined,
        }),
      });
      const responseData = await response.json().catch(() => ({})) as { item?: OkriItem; error?: string; messageCode?: string };
      if (!response.ok || !responseData.item) throw new Error(apiError(responseData, "항목을 만들지 못했습니다."));
      const filledValues = Object.fromEntries(Object.entries(customValues).filter(([, value]) => value !== null && value !== ""));
      const propertyResults = await Promise.all((kind === "project" ? Object.entries(filledValues) : []).map(async ([propertyId, value]) => fetch("/api/property-values", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ itemId: responseData.item!.id, propertyId, value }),
      })));
      const propertySaveFailed = propertyResults.some((result) => !result.ok);
      onCreated(responseData.item, propertySaveFailed ? {} : filledValues, propertySaveFailed ? "항목은 만들었지만 일부 속성을 저장하지 못했습니다." : undefined);
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : t("항목을 만들지 못했습니다."));
    } finally {
      setSaving(false);
    }
  }
  return (
    <OverlayDialog title={t("새 항목")} variant="drawer" dirty={dirty} initialFocus="input" onRequestClose={() => onClose()}>
      {(requestClose) => <aside className="property-panel">
        <header><div><h2>{t("새 항목")}</h2><p>{kind === "project" ? t("Project 속성을 지정해서 추가") : t("OKR 실행 구조에 추가")}</p></div><button className="icon-button" onClick={() => requestClose("close-button")} aria-label={t("새 항목 닫기")} title={t("새 항목 닫기")}><X size={17} /></button></header>
        <form className="property-form create-item-form" onSubmit={submit}>
          <label><span>{t("유형")}</span><select value={kind} disabled><option value={initialKind}>{kindLabel(initialKind)}</option></select></label>
          <label><span>{t("이름")}</span><input value={title} onChange={(event) => setTitle(event.target.value)} /></label>
          {onCreateWithChat && <div className="create-chat-nudge"><div><Bot size={15} /><span><b>{t("대화로 정리할까요?")}</b><small>{kind === "task" ? t("할 일을 다듬고, 연결 대상을 고르지 않으면 General에 저장합니다.") : kind === "project" ? t("결과와 범위를 말하면 Project 초안을 정리합니다.") : t("말로 설명하면 OKR 초안을 함께 정리해드려요.")}</small></span></div><button type="button" onClick={() => onCreateWithChat({ kind, title })}>{t("AI 대화로 추가")}<ChevronRight size={13} /></button></div>}
          {kind === "task" ? hasTaskContainerOptions ? (
            <label><span>{t("연결 대상 · 선택 사항")}</span><select value={taskContainer} onChange={(event) => setTaskContainer(event.target.value)}><option value="">{t("선택 안 함 — General에 저장")}</option>{taskProjectOptions.length > 0 && <optgroup label={t("Project")}>{taskProjectOptions.map((entry) => <option value={`project:${entry.id}`} key={entry.id}>{entry.title}</option>)}</optgroup>}{taskRoutineOptions.length > 0 && <optgroup label={t("Routine")}>{taskRoutineOptions.map((entry) => <option value={`routine:${entry.id}`} key={entry.id}>{entry.title}</option>)}</optgroup>}</select></label>
          ) : (
            <p className="task-container-empty task-container-general">{t("연결할 Project·Routine이 없어 General(기본)에 저장됩니다.")}</p>
          ) : parentKind && (
            <label><span>{t("상위 {kind}", { kind: kindLabel(parentKind) })}</span><select value={parentId} onChange={(event) => setParentId(event.target.value)}><option value="">{t("선택")}</option>{parentOptions.map((entry) => <option value={entry.id} key={entry.id}>{entry.title}</option>)}</select></label>
          )}
          {kind === "project" && (
            <section className="create-project-fields">
              <header><b>{t("Project 속성")}</b><span>{t("생성할 때 바로 지정")}</span></header>
              {availableTemplates.length > 0 && <label><span>{t("본문 템플릿")}</span><select value={templateId} onChange={(event) => setTemplateId(event.target.value)}><option value="">{t("나중에 불러오기")}</option>{availableTemplates.map((template) => <option value={template.id} key={template.id}>{template.name}</option>)}</select></label>}
              <label><span>{t("본문")}</span><textarea value={description} onChange={(event) => setDescription(event.target.value)} rows={6} placeholder={t("# 배경\n\n## 범위\n\n## 다음 액션")} /></label>
              <div className="project-field-grid">
                <label><span>{t("우선순위")}</span><select className={`priority-${priority}`} value={priority} onChange={(event) => setPriority(event.target.value as Priority)}>{Object.entries(priorityLabels).map(([value, label]) => <option value={value} key={value}>{label}</option>)}</select></label>
                <label><span>{t("상태")}</span><select value={status} onChange={(event) => setStatus(event.target.value as ItemStatus)}>{Object.entries(statusLabels).filter(([value]) => value !== "archived").map(([value, label]) => <option value={value} key={value}>{label}</option>)}</select></label>
                <label><span>{t("기한")}</span><input type="date" value={dueDate} onChange={(event) => setDueDate(event.target.value)} /></label>
              </div>
              {teamMembers.length > 0 && (
                <MemberMentionPicker label={t("책임자")} members={teamMembers} selectedIds={projectDriIds} onChange={setProjectDriIds} placeholder={t("@실명으로 찾기")} maxSelected={1} />
              )}
              {teamMembers.length > 0 && (
                <MemberMentionPicker label={t("하위 업무자")} members={teamMembers} selectedIds={projectWorkerIds} onChange={setProjectWorkerIds} placeholder={t("@실명으로 여러 명 태그")} />
              )}
              {projectProperties.length > 0 && <div className="project-field-grid custom-project-fields">{projectProperties.map((property) => <CreatePropertyField key={property.id} property={property} value={customValues[property.id] ?? property.defaultValue} members={teamMembers} onChange={updateCustomValue} />)}</div>}
            </section>
          )}
          {kind === "task" && teamMembers.length > 0 && (
            <MemberMentionPicker label={t("담당자")} members={teamMembers} selectedIds={taskAssigneeIds} onChange={setTaskAssigneeIds} placeholder={t("@실명으로 찾기")} maxSelected={1} />
          )}
          {error && <p className="inline-error" role="alert">{error}</p>}
          <button disabled={!title.trim() || saving}>{saving ? t("저장 중") : t("만들기")}</button>
        </form>
      </aside>}
    </OverlayDialog>
  );
}

function CreatePropertyField({ property, value, members, onChange }: { property: PropertyDefinition; value: PropertyValue; members: TeamMember[]; onChange: (property: PropertyDefinition, value: PropertyValue) => void }) {
  return <label><span>{systemPropertyLabel(property, t)}</span><PropertyValueInput type={property.type} value={value} options={property.options} members={members} onChange={(next) => onChange(property, next)} /></label>;
}

function RoutineView({ workspaceId, focusId, onDirtyChange, initialRoutines, teamMembers, onNotice, onRoutinesChange, createOpen, onCreateClose, onCreateWithChat, readOnly, canManageProperties }: { focusId?: string | null; onDirtyChange: (dirty: boolean) => void; readOnly: boolean; canManageProperties: boolean; workspaceId: string; initialRoutines: Routine[]; teamMembers: TeamMember[]; onNotice: (message: string) => void; onRoutinesChange: (routines: Routine[]) => void; createOpen: boolean; onCreateClose: () => void; onCreateWithChat: (initialMessage?: string) => void }) {
  const confirmAction = useAppConfirm();
  const initialDate = localDate();
  const initialCacheKey = `routines:${workspaceId}:${initialDate}`;
  const [date, setDate] = useState(initialDate);
  const [rows, setRows] = useState<Routine[] | null>(() => routineMemoryCache.get(initialCacheKey) ?? initialRoutines);
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [triggerPoint, setTriggerPoint] = useState("");
  const [actionPlace, setActionPlace] = useState("");
  const [actionSteps, setActionSteps] = useState("");
  const [cadence, setCadence] = useState<RoutineCadence>("daily");
  const [assigneeMemberId, setAssigneeMemberId] = useState("");
  const [drafts, setDrafts] = useState<Record<string, Pick<Routine, "description" | "triggerPoint" | "actionPlace" | "actionSteps">>>({});
  const [propertyDefinitions, setPropertyDefinitions] = useState<PropertyDefinition[]>([]);
  const [propertyDrafts, setPropertyDrafts] = useState<Record<string, Record<string, PropertyValue>>>({});
  const [createProperties, setCreateProperties] = useState<Record<string, PropertyValue>>({});
  const [propertySettingsOpen, setPropertySettingsOpen] = useState(false);
  const [propertyError, setPropertyError] = useState(false);
  const [propertyAttempt, setPropertyAttempt] = useState(0);
  const [propertiesReady, setPropertiesReady] = useState(false);
  const activeProperties = propertyDefinitions.filter((property) => property.active);
  const [expandedIds, setExpandedIds] = useState<Set<string>>(() => new Set());
  useEffect(() => {
    if (!focusId) return;
    const timer = window.setTimeout(() => {
      setExpandedIds((current) => new Set([...current, focusId]));
      const target = document.getElementById(`routine-search-${focusId}`);
      target?.scrollIntoView({ block: "center" }); target?.focus({ preventScroll: true });
    }, 0);
    return () => window.clearTimeout(timer);
  }, [focusId]);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    void fetch("/api/routine-properties?includeInactive=true", { signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error();
        const data = await response.json() as { properties: PropertyDefinition[] };
        if (!controller.signal.aborted) { setPropertyDefinitions(data.properties); setPropertyError(false); setPropertiesReady(true); }
      }).catch(() => { if (!controller.signal.aborted) setPropertyError(true); });
    return () => controller.abort();
  }, [workspaceId, propertyAttempt]);

  function propertyInputs(values: Record<string, PropertyValue>, onChange: (id: string, value: PropertyValue) => void, creating = false) {
    return <div className="routine-property-inputs">{activeProperties.map((property) => <PropertyDefaultInput key={property.id} label={systemPropertyLabel(property, t)} type={property.type} options={property.options} value={Object.hasOwn(values, property.id) ? values[property.id] : creating ? property.defaultValue : null} members={teamMembers} disabled={readOnly || saving} onChange={(value) => onChange(property.id, value)} />)}</div>;
  }
  const [loadError, setLoadError] = useState(false);
  const [loadAttempt, setLoadAttempt] = useState(0);
  const rowsRef = useRef(rows);

  useEffect(() => { rowsRef.current = rows; }, [rows]);
  useEffect(() => {
    let active = true;
    const key = `routines:${workspaceId}:${date}`;
    const cached = routineMemoryCache.get(key);
    if (cached && viewCacheIsFresh(key)) return () => { active = false; };
    fetch(`/api/routines?date=${date}`)
      .then(async (response) => response.ok ? response.json() as Promise<{ routines: Routine[] }> : Promise.reject())
      .then((data) => { if (active) { routineMemoryCache.set(key, data.routines); markViewCacheFresh(key); setLoadError(false); setRows(data.routines); onRoutinesChange(data.routines); } })
      .catch(() => { if (active && rowsRef.current === null) setLoadError(true); });
    return () => { active = false; };
  }, [date, loadAttempt, onRoutinesChange, workspaceId]);
  useEffect(() => {
    if (!rows) return;
    const key = `routines:${workspaceId}:${date}`;
    routineMemoryCache.set(key, rows);
    markViewCacheFresh(key);
  }, [date, rows, workspaceId]);

  async function create(event: FormEvent) {
    event.preventDefault();
    if (!title.trim() || saving || readOnly || !propertiesReady) return;
    setSaving(true);
    try {
      const response = await fetch("/api/routines", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title, description, triggerPoint, actionPlace, actionSteps, cadence, date, assigneeMemberId: assigneeMemberId || null, properties: createProperties }),
      });
      if (!response.ok) throw new Error(t("Routine을 추가하지 못했습니다."));
      const data = await response.json() as { routine: Routine };
      setRows((current) => {
        const next = [...(current ?? []), data.routine];
        onRoutinesChange(next);
        return next;
      });
      setTitle("");
      setDescription("");
      setTriggerPoint("");
      setActionPlace("");
      setActionSteps("");
      setAssigneeMemberId("");
      setCadence("daily");
      setCreateProperties({});
      onCreateClose();
      onNotice(t("Routine을 추가했습니다."));
    } catch (createError) {
      onNotice(createError instanceof Error ? createError.message : t("Routine을 추가하지 못했습니다."));
    } finally {
      setSaving(false);
    }
  }

  async function toggleCompletion(routine: Routine) {
    if (routine.systemKey === "general") return;
    const completed = !routine.completed;
    const previous = rows;
    setRows((current) => current?.map((entry) => entry.id === routine.id ? { ...entry, completed } : entry) ?? null);
    try {
      const response = await fetch("/api/routine-completions", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ routineId: routine.id, date, completed }),
      });
      if (!response.ok) throw new Error(t("Routine 완료 상태를 저장하지 못했습니다."));
      const data = await response.json() as { routine: Routine };
      setRows((current) => {
        const next = current?.map((entry) => entry.id === routine.id ? data.routine : entry) ?? [];
        onRoutinesChange(next);
        return next;
      });
    } catch (toggleError) {
      setRows(previous);
      onNotice(toggleError instanceof Error ? toggleError.message : t("Routine 완료 상태를 저장하지 못했습니다."));
    }
  }

  async function toggleActive(routine: Routine) {
    if (routine.systemKey === "general") return;
    const active = !routine.active;
    const previous = rows;
    setRows((current) => current?.map((entry) => entry.id === routine.id ? { ...entry, active } : entry) ?? null);
    try {
      const response = await fetch("/api/routines", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: routine.id, active, date }),
      });
      if (!response.ok) throw new Error(t("Routine 활성 상태를 저장하지 못했습니다."));
      const data = await response.json() as { routine: Routine };
      setRows((current) => {
        const next = current?.map((entry) => entry.id === routine.id ? data.routine : entry) ?? [];
        onRoutinesChange(next);
        return next;
      });
    } catch (toggleError) {
      setRows(previous);
      onNotice(toggleError instanceof Error ? toggleError.message : t("Routine 활성 상태를 저장하지 못했습니다."));
    }
  }

  function routineDraft(routine: Routine) {
    return drafts[routine.id] ?? {
      description: routine.description,
      triggerPoint: routine.triggerPoint,
      actionPlace: routine.actionPlace,
      actionSteps: routine.actionSteps,
    };
  }

  function updateDraft(routine: Routine, field: "description" | "triggerPoint" | "actionPlace" | "actionSteps", value: string) {
    setDrafts((current) => ({ ...current, [routine.id]: { ...routineDraft(routine), [field]: value } }));
  }

  function hasDraftChange(routine: Routine) {
    const draft = drafts[routine.id];
    return Boolean(Object.keys(propertyDrafts[routine.id] ?? {}).length) || Boolean(draft) && (
      draft.description !== routine.description ||
      draft.triggerPoint !== routine.triggerPoint ||
      draft.actionPlace !== routine.actionPlace ||
      draft.actionSteps !== routine.actionSteps
    );
  }

  async function saveRoutineGuide(routine: Routine) {
    if (routine.systemKey === "general" || readOnly || saving) return;
    const draft = routineDraft(routine);
    setSaving(true);
    try {
    const response = await fetch("/api/routines", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: routine.id, date, ...draft, properties: propertyDrafts[routine.id] }),
    });
    setSaving(false);
    if (!response.ok) { const failure = await response.json() as { error?: string; code?: string; messageCode?: string; messageValues?: unknown }; onNotice(apiError(failure, "Routine을 저장하지 못했습니다.")); return; }
    const data = await response.json() as { routine: Routine };
    setRows((current) => {
      const next = current?.map((entry) => entry.id === routine.id ? data.routine : entry) ?? [];
      onRoutinesChange(next);
      return next;
    });
    setDrafts((current) => {
      const next = { ...current };
      delete next[routine.id];
      return next;
    });
    setPropertyDrafts((current) => { const next = { ...current }; delete next[routine.id]; return next; });
    onNotice(t("Routine 속성과 실행 방법을 저장했습니다."));
    return true;
    } catch { onNotice(t("Routine을 저장하지 못했습니다. 입력 내용은 유지됩니다.")); }
    finally { setSaving(false); }
  }

  async function remove(id: string) {
    const routine = rows?.find((entry) => entry.id === id);
    if (!routine || routine.systemKey === "general") return;
    if (!await confirmAction({ title: t("Routine 삭제"), message: t("'{value1}' Routine을 삭제합니다.", { value1: messageValue(routine.title) }), confirmLabel: t("Routine 삭제"), danger: true })) return;
    const response = await fetch(`/api/routines?id=${encodeURIComponent(id)}`, { method: "DELETE" });
    if (response.ok) {
      setRows((current) => {
        const next = current?.filter((entry) => entry.id !== id) ?? [];
        onRoutinesChange(next);
        return next;
      });
      onNotice(t("Routine을 삭제했습니다."));
    } else onNotice(t("Routine을 삭제하지 못했습니다."));
  }

  async function updateAssignee(routine: Routine, memberId: string) {
    if (routine.systemKey === "general") return;
    const response = await fetch("/api/routines", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: routine.id, date, assigneeMemberId: memberId || null }),
    });
    if (!response.ok) {
      onNotice(t("Routine 담당자를 저장하지 못했습니다."));
      return;
    }
    const data = await response.json() as { routine: Routine };
    setRows((current) => {
      const next = current?.map((entry) => entry.id === routine.id ? data.routine : entry) ?? [];
      onRoutinesChange(next);
      return next;
    });
  }

  const createDirty = Boolean(title.trim() || description.trim() || triggerPoint.trim() || actionPlace.trim() || actionSteps.trim() || cadence !== "daily" || assigneeMemberId || Object.keys(createProperties).length);
  const routineDirty = Boolean(rows?.some((routine) => hasDraftChange(routine)));
  useEffect(() => onDirtyChange(routineDirty), [routineDirty, onDirtyChange]);
  useEffect(() => () => onDirtyChange(false), [onDirtyChange]);

  return (<>
    <section className="routine-section">
      <div className="routine-toolbar">
        <label><CalendarDays size={14} /><input type="date" value={date} onChange={(event) => { const nextDate = event.target.value; setRows(routineMemoryCache.get(`routines:${workspaceId}:${nextDate}`) ?? null); setLoadError(false); setDate(nextDate); }} /></label>
        <p>{t("반복 실행 날짜와 오늘의 완료 상태를 확인합니다.")}</p><button className="secondary" type="button" onClick={() => setPropertySettingsOpen(true)}><Settings2 size={16} />{t("루틴 속성 관리")}</button>
      </div>
      {propertyError && <div role="alert" className="routine-property-error">{t("루틴 속성을 불러오지 못했습니다.")}<button type="button" className="secondary" onClick={() => setPropertyAttempt((value) => value + 1)}>{t("다시 시도")}</button></div>}
      <div className="routine-cards">
        {loadError && rows === null ? <AsyncState icon={AlertTriangle} title={t("Routine을 불러오지 못했습니다")} detail={t("잠시 후 다시 시도해 주세요.")} actionLabel={t("다시 시도")} onAction={() => { setRows(null); setLoadError(false); setLoadAttempt((attempt) => attempt + 1); }} /> : rows === null ? <AsyncState icon={LoaderCircle} title={t("Routine을 불러오는 중입니다")} loading /> : rows.length ? rows.map((routine) => {
          const draft = routineDraft(routine);
          const expanded = expandedIds.has(routine.id);
          const detailsId = `routine-details-${routine.id}`;
          return (
            <article id={`routine-search-${routine.id}`} tabIndex={-1} className={`routine-card ${routine.active ? "" : "inactive"} ${routine.systemKey === "general" ? "general-routine" : ""} ${focusId === routine.id ? "search-target" : ""}`} key={routine.id}>
              <header>
                {routine.systemKey === "general" ? <span className="general-routine-icon"><Inbox size={13} /></span> : <button className={`task-check ${routine.completed ? "checked" : ""}`} disabled={readOnly || !routine.active} onClick={() => void toggleCompletion(routine)} aria-label={routine.completed ? t("완료 취소") : t("완료 처리")}><Check size={12} /></button>}
                {routine.systemKey === "general" ? <div><b>{routine.title}<em className="system-badge">{t("기본")}</em></b><small>{t("Project·Routine에 연결하지 않은 Task가 모이는 기본 목록")}</small></div> : <button type="button" className="routine-expand" aria-expanded={expanded} aria-controls={detailsId} onClick={() => setExpandedIds((current) => { const next = new Set(current); if (next.has(routine.id)) next.delete(routine.id); else next.add(routine.id); return next; })}><span><b>{routine.title}</b><small>{routineCadenceLabel(routine.cadence)} · {routine.completed ? t("오늘 완료") : t("오늘 미완료")} · {teamMembers.find((member) => member.id === routine.assigneeMemberId)?.displayName ?? t("담당자 없음")}{hasDraftChange(routine) ? t(" · 저장하지 않은 변경") : ""}</small></span><ChevronDown size={16} /></button>}
              </header>
              {routine.systemKey !== "general" && <div className="routine-details" id={detailsId} hidden={!expanded}>
              <DocumentProperties readOnly={readOnly} autoSave={false} dirty={hasDraftChange(routine)} onEditorClose={() => {
                setDrafts(current => { const next = { ...current }; delete next[routine.id]; return next; });
                setPropertyDrafts(current => { const next = { ...current }; delete next[routine.id]; return next; });
              }} entries={[
                { key: "cadence", label: t("반복 주기"), value: routineCadenceLabel(routine.cadence), primary: true },
                { key: "assignee", label: t("담당자"), value: teamMembers.find(member => member.id === routine.assigneeMemberId)?.displayName ?? t("담당자 없음"), primary: true },
                { key: "active", label: t("Routine 활성 상태"), value: routine.active ? t("활성") : t("일시정지") },
                { key: "trigger", label: t("트리거 포인트"), value: routine.triggerPoint || t("미지정") },
                { key: "place", label: t("어디서"), value: routine.actionPlace || t("미지정") },
                ...activeProperties.map(property => ({ key: property.id, label: systemPropertyLabel(property, t), value: documentPropertyValue(property, routine.properties?.[property.id] ?? null, teamMembers) })),
              ]}>{close => <>
              <div className="property-form routine-guide-grid">
                <label><span>{t("트리거 포인트")}</span><input value={draft.triggerPoint} onChange={(event) => updateDraft(routine, "triggerPoint", event.target.value)} placeholder={t("예: 오전 9시, Slack 알림 확인 후")} /></label>
                <label><span>{t("어디서")}</span><input value={draft.actionPlace} onChange={(event) => updateDraft(routine, "actionPlace", event.target.value)} placeholder={t("예: OKRI 작업 탭, 캘린더, 책상")} /></label>
                <label><span>{t("목적/메모")}</span><input value={draft.description} onChange={(event) => updateDraft(routine, "description", event.target.value)} placeholder={t("왜 반복하는지")} /></label>
                <label className="routine-steps"><span>{t("무엇을 어떻게")}</span><textarea value={draft.actionSteps} onChange={(event) => updateDraft(routine, "actionSteps", event.target.value)} placeholder={t("1. 확인할 것\n2. 실행할 것\n3. 끝났다고 판단하는 기준")} rows={3} /></label>
              </div>
              <section className="routine-property-values property-form" aria-label={t("{value1} 속성 값", { value1: messageValue(routine.title) })}><h3>{t("속성 값")}</h3>{activeProperties.length ? propertyInputs({ ...routine.properties, ...propertyDrafts[routine.id] }, (id, value) => setPropertyDrafts((current) => ({ ...current, [routine.id]: { ...current[routine.id], [id]: value } }))) : <p>{propertiesReady ? t("아직 루틴 속성이 없습니다. 루틴 속성 관리에서 추가할 수 있습니다.") : t("루틴 속성을 불러오는 중입니다.")}</p>}</section>
              <div className="property-form"><label className="document-checkbox"><input type="checkbox" checked={routine.active} onChange={() => void toggleActive(routine)} /><span>{t("Routine 활성 상태")}</span></label></div>
              <footer>
                <label className="routine-assignee"><span>{t("담당자")}</span><select value={routine.assigneeMemberId ?? ""} onChange={(event) => void updateAssignee(routine, event.target.value)}><option value="">{t("담당자 없음")}</option>{teamMembers.filter((member) => member.status === "active").map((member) => <option value={member.id} key={member.id}>{member.displayName}</option>)}</select></label>
                <button className="icon-button" disabled={saving} onClick={() => void remove(routine.id)} aria-label={t("Routine 삭제")} title={t("Routine 삭제")}><Trash2 size={13} /></button>
                <button className="primary-action" disabled={readOnly || !hasDraftChange(routine) || saving} aria-busy={saving} onClick={async () => { if (await saveRoutineGuide(routine)) close(); }}><Check size={14} />{t("저장")}</button>
              </footer></>}</DocumentProperties>
              {expanded && <WorkDocumentSection key={`routine-document:${routine.id}`} targetKind="routine" targetId={routine.id} readOnly={readOnly} onNotice={onNotice} />}
              </div>}
            </article>
          );
        }) : <EmptyState icon={Repeat2} title={t("등록된 Routine이 없습니다")} />}
      </div>
    </section>
    {createOpen && <OverlayDialog title={t("새 Routine")} variant="drawer" dirty={createDirty} initialFocus="input" onRequestClose={onCreateClose}>
      {(requestClose) => <aside className="property-panel routine-create-panel">
        <header><div><h2>{t("새 Routine")}</h2><p>{t("OKR과 독립된 반복 실행을 추가합니다.")}</p></div><button className="icon-button" onClick={() => requestClose("close-button")} aria-label={t("새 Routine 닫기")} title={t("새 Routine 닫기")}><X size={17} /></button></header>
        <form className="property-form routine-create" onSubmit={create}>
          <label><span>{t("이름")}</span><input value={title} onChange={(event) => setTitle(event.target.value)} placeholder={t("예: 매일 고객 피드백 확인")} aria-label={t("Routine 이름")} /></label>
          <div className="create-chat-nudge"><div><Bot size={15} /><span><b>{t("대화로 정리할까요?")}</b><small>{t("반복할 일을 말하면 트리거와 실행 방법을 정리합니다.")}</small></span></div><button type="button" onClick={() => onCreateWithChat(title)}>{t("AI 대화로 추가")}<ChevronRight size={13} /></button></div>
          <label><span>{t("반복 주기")}</span><select value={cadence} onChange={(event) => setCadence(event.target.value as RoutineCadence)} aria-label={t("반복 주기")}><option value="daily">{t("매일")}</option><option value="weekly">{t("매주")}</option><option value="monthly">{t("매월")}</option></select></label>
          <label><span>{t("트리거 포인트")}</span><input value={triggerPoint} onChange={(event) => setTriggerPoint(event.target.value)} placeholder={t("예: 오전 9시")} aria-label={t("트리거 포인트")} /></label>
          <label><span>{t("어디서")}</span><input value={actionPlace} onChange={(event) => setActionPlace(event.target.value)} placeholder={t("장소 또는 도구")} aria-label={t("어디서 실행")} /></label>
          <label><span>{t("목적/메모")}</span><input value={description} onChange={(event) => setDescription(event.target.value)} placeholder={t("왜 반복하는지")} aria-label={t("Routine 목적")} /></label>
          <label><span>{t("담당자")}</span><select value={assigneeMemberId} onChange={(event) => setAssigneeMemberId(event.target.value)} aria-label={t("Routine 담당자")}><option value="">{t("담당자 없음")}</option>{teamMembers.filter((member) => member.status === "active").map((member) => <option value={member.id} key={member.id}>{member.displayName}</option>)}</select></label>
          <label><span>{t("무엇을 어떻게")}</span><textarea value={actionSteps} onChange={(event) => setActionSteps(event.target.value)} placeholder={t("실행 순서와 완료 기준")} aria-label={t("실행 방법")} rows={5} /></label>
          <section className="routine-property-values" aria-label={t("새 루틴 속성 값")}><h3>{t("속성 값")}</h3>{propertyInputs(createProperties, (id, value) => setCreateProperties((current) => ({ ...current, [id]: value })), true)}{propertiesReady && !activeProperties.length && <p>{t("루틴 속성 관리에서 속성을 추가할 수 있습니다.")}</p>}</section>
          <button className="primary-action" disabled={readOnly || !title.trim() || saving || !propertiesReady}>{saving ? t("추가 중") : t("Routine 추가")}</button>
        </form>
      </aside>}
    </OverlayDialog>}
    {propertySettingsOpen && <OverlayDialog title={t("루틴 속성 관리")} onRequestClose={() => setPropertySettingsOpen(false)}>
      {(requestClose) => <section className="routine-property-settings"><header><h2>{t("루틴 속성 관리")}</h2><button className="icon-button" aria-label={t("루틴 속성 관리 닫기")} onClick={() => requestClose("close-button")}><X size={17} /></button></header><ProjectPropertyManager scope="routine" workspaceId={workspaceId} properties={propertyDefinitions} teamMembers={teamMembers} readOnly={!canManageProperties || readOnly} onChanged={(next) => { setPropertyDefinitions(next); setPropertiesReady(true); }} onNotice={onNotice} /></section>}
    </OverlayDialog>}
  </>);
}

function MyWorkView({ workspaceId, items, routines, currentMember, onOpenProject, onOpenTask, onRoutinesChange, onNotice }: {
  workspaceId: string;
  items: OkriItem[];
  routines: Routine[];
  currentMember: TeamMember | null;
  onOpenProject: (id: string) => void;
  onOpenTask: (id: string) => void;
  onRoutinesChange: (routines: Routine[]) => void;
  onNotice: (message: string) => void;
}) {
  const [includeCompleted, setIncludeCompleted] = useState(false);
  const [sort, setSort] = useState<MyWorkSort>(() => readMyWorkSort(workspaceId, currentMember?.id ?? ""));
  const [savingRoutineId, setSavingRoutineId] = useState<string | null>(null);
  if (!currentMember) return <EmptyState icon={Briefcase} title={t("현재 멤버 정보를 확인할 수 없습니다")} />;

  const visible = (status: ItemStatus) => includeCompleted || !isCompletedStatus(status);
  const projects = sortMyWorkItems(items.filter((entry) => entry.kind === "project" && visible(entry.status) && entry.assignments.some((assignment) => assignment.memberId === currentMember.id && (assignment.role === "project_dri" || assignment.role === "project_worker"))), sort);
  const tasks = sortMyWorkItems(items.filter((entry) => entry.kind === "task" && visible(entry.status) && entry.assignments.some((assignment) => assignment.memberId === currentMember.id && assignment.role === "task_assignee")), sort);
  const assignedRoutines = routines.filter((entry) => entry.systemKey !== "general" && entry.assigneeMemberId === currentMember.id && (includeCompleted || !entry.completed));
  const byId = new Map(items.map((entry) => [entry.id, entry]));

  async function toggleRoutine(routine: Routine) {
    setSavingRoutineId(routine.id);
    const response = await fetch("/api/routine-completions", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ routineId: routine.id, date: localDate(), completed: !routine.completed }),
    });
    setSavingRoutineId(null);
    if (!response.ok) {
      onNotice(t("Routine 완료 상태를 저장하지 못했습니다."));
      return;
    }
    const data = await response.json() as { routine: Routine };
    onRoutinesChange(routines.map((entry) => entry.id === routine.id ? data.routine : entry));
  }

  return (
    <section className="my-work-view">
      <header className="my-work-toolbar">
        <div><b>{t("{name}의 업무", { name: currentMember.displayName })}</b><span>{t("명시적으로 담당된 항목만 표시합니다.")}</span></div>
        <div className="my-work-toolbar-actions">
          <div className="my-work-sort" role="group" aria-label={t("내 업무 정렬")}>
            {([ ["due", t("기한순")], ["priority", t("우선순위순")] ] as const).map(([value, label]) => <button key={value} type="button" aria-pressed={sort === value} onClick={() => { setSort(value); saveMyWorkSort(workspaceId, currentMember.id, value); }}>{label}</button>)}
          </div>
          <label><input type="checkbox" checked={includeCompleted} onChange={(event) => setIncludeCompleted(event.target.checked)} />{t("완료 포함")}</label>
        </div>
      </header>
      <MyWorkSection title={t("Task")} count={tasks.length}>
        {tasks.map((task) => {
          const project = task.parentId ? byId.get(task.parentId) : null;
          const routine = task.routineId ? routines.find((entry) => entry.id === task.routineId) : null;
          return <button className="my-work-item" key={task.id} onClick={() => onOpenTask(task.id)}><span className={`type-icon type-task ${isCompletedStatus(task.status) ? "completed" : ""}`}><Check size={12} /></span><span><b>{task.title}</b><span className="my-work-item-meta"><small>{routine?.systemKey === "general" ? t("미분류 Task") : routine ? routine.title : project?.title ?? t("미분류 Task")}</small><span className={`my-work-priority priority-${task.priority}`}>{priorityLabels[task.priority]}</span><span className="my-work-due">{dueLabel(task.dueDate)}</span></span></span><ChevronRight size={15} /></button>;
        })}
      </MyWorkSection>
      <MyWorkSection title={t("Project")} count={projects.length}>
        {projects.map((project) => {
          const roles = project.assignments.filter((assignment) => assignment.memberId === currentMember.id).map((assignment) => assignment.role === "project_dri" ? t("책임자") : t("참여자"));
          return <button className="my-work-item" key={project.id} onClick={() => onOpenProject(project.id)}><span className="type-icon type-project">P</span><span><b className="project-item-title">{project.title}</b><span className="my-work-item-meta"><small>{roles.join(" · ")} · {statusLabel(project.status)}</small><span className={`my-work-priority priority-${project.priority}`}>{priorityLabels[project.priority]}</span><span className="my-work-due">{dueLabel(project.dueDate)}</span></span></span><ChevronRight size={15} /></button>;
        })}
      </MyWorkSection>
      <MyWorkSection title={t("Routine")} count={assignedRoutines.length}>
        {assignedRoutines.map((routine) => <article className="my-work-routine" key={routine.id}><div><span className="type-icon"><Repeat2 size={13} /></span><span><b>{routine.title}</b><small>{routineCadenceLabel(routine.cadence)} · {routine.completed ? t("오늘 완료") : t("오늘 미완료")}</small></span></div>{(routine.triggerPoint || routine.actionPlace || routine.actionSteps || routine.description) && <p>{[routine.triggerPoint, routine.actionPlace, routine.actionSteps || routine.description].filter(Boolean).join(" · ")}</p>}<button className={routine.completed ? "is-complete" : ""} disabled={savingRoutineId === routine.id || !routine.active} onClick={() => void toggleRoutine(routine)}><Check size={14} />{savingRoutineId === routine.id ? t("저장 중") : routine.completed ? t("완료 취소") : t("오늘 완료")}</button></article>)}
      </MyWorkSection>
    </section>
  );
}

function MyWorkSection({ title, count, children }: { title: string; count: number; children: ReactNode }) {
  return <section className="my-work-section"><header><b>{title}</b><span>{count}</span></header><div>{count ? children : <p className="my-work-empty">{t("담당된 {kind}가 없습니다.", { kind: title })}</p>}</div></section>;
}

function isDailyTaskKey(key: string) { return key.startsWith("task:"); }

function DailyScrumView({ workspaceId, onOpenTask, onOpenProject, onNavigate, onNotice }: { workspaceId: string; onOpenProject: (id: string) => void; onNavigate: (view: View) => void; onOpenTask: (id: string) => void; onNotice: (message: string) => void }) {
  const initialDate = localDate();
  const initialCacheKey = `daily:${workspaceId}:${initialDate}`;
  const initialScrum = dailyScrumMemoryCache.get(initialCacheKey) ?? null;
  const [date, setDate] = useState(initialDate);
  const [scrum, setScrum] = useState<DailyDashboard | null>(initialScrum);
  const [saving, setSaving] = useState<"draft" | "submit" | "task" | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [loadAttempt, setLoadAttempt] = useState(0);
  const [savedNotes, setSavedNotes] = useState(initialScrum ? scrumNotesSnapshot(initialScrum) : "");
  const submitRequestId = useRef(crypto.randomUUID());
  const [newTaskTitle, setNewTaskTitle] = useState("");
  const [newTaskParent, setNewTaskParent] = useState("");
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const token = params.get("slack_link");
    if (!token) return;
    params.delete("slack_link");
    window.history.replaceState(window.history.state, "", `${window.location.pathname}${params.size ? `?${params}` : ""}`);
    void fetch("/api/slack/link", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ token }) })
      .then(async (response) => { const result = await response.json() as { error?: string }; if (!response.ok) throw new Error(apiError(result, "Slack 사용자를 연결하지 못했습니다.")); onNotice(t("Slack 사용자 연결을 완료했습니다.")); })
      .catch((error: unknown) => onNotice(error instanceof Error ? error.message : t("Slack 사용자를 연결하지 못했습니다.")));
  }, [onNotice]);
  useEffect(() => {
    let active = true;
    const key = `daily:${workspaceId}:${date}`;
    const cachedScrum = dailyScrumMemoryCache.get(key) ?? null;
    if (cachedScrum && viewCacheIsFresh(key)) return () => { active = false; };
    fetch(`/api/daily-scrum?date=${date}`)
      .then(async (response) => response.ok ? response.json() as Promise<DailyDashboard> : Promise.reject())
      .then((data) => { if (active) { dailyScrumMemoryCache.set(key, data); markViewCacheFresh(key); setLoadError(false); setScrum(data); setSavedNotes(scrumNotesSnapshot(data)); setNewTaskParent(defaultDailyParent(data)); } })
      .catch(() => { if (active && !cachedScrum) setLoadError(true); });
    return () => { active = false; };
  }, [date, loadAttempt, workspaceId]);
  const notesDirty = Boolean(scrum) && savedNotes !== scrumNotesSnapshot(scrum!);
  useEffect(() => {
    if (!notesDirty) return;
    function warnBeforeUnload(event: BeforeUnloadEvent) { event.preventDefault(); event.returnValue = ""; }
    window.addEventListener("beforeunload", warnBeforeUnload);
    return () => window.removeEventListener("beforeunload", warnBeforeUnload);
  }, [notesDirty]);
  if (loadError) return <AsyncState icon={AlertTriangle} title={t("데일리 스크럼을 불러오지 못했습니다")} detail={t("날짜를 유지한 채 다시 불러옵니다.")} actionLabel={t("다시 시도")} onAction={() => { setScrum(null); setLoadError(false); setLoadAttempt((attempt) => attempt + 1); }} />;
  if (!scrum) return <AsyncState icon={LoaderCircle} title={t("데일리 스크럼을 불러오는 중입니다")} loading />;
  const currentScrum = scrum;
  async function save(showNotice = true) {
    setSaving("draft");
    try {
      const response = await fetch("/api/daily-scrum", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...currentScrum.draft,
        selectedWorkIds: currentScrum.draft.selectedWorkIds?.filter(isDailyTaskKey),
        selectedYesterdayWorkIds: currentScrum.draft.selectedYesterdayWorkIds?.filter(isDailyTaskKey), date }) });
      const data = await response.json() as DailyDashboard & { error?: string };
      if (!response.ok) throw new Error(apiError(data, "데일리 초안을 저장하지 못했습니다."));
      const key = `daily:${workspaceId}:${date}`; dailyScrumMemoryCache.set(key, data); markViewCacheFresh(key); setScrum(data); setSavedNotes(scrumNotesSnapshot(data));
      if (showNotice) onNotice(t("데일리 초안을 저장했습니다."));
      return data;
    } catch (saveError) {
      onNotice(saveError instanceof Error ? saveError.message : t("데일리 초안을 저장하지 못했습니다."));
      return null;
    } finally {
      setSaving(null);
    }
  }

  async function submit() {
    const isRevision = Boolean(currentScrum.latestSubmission);
    const hasContainerSelections = [...(currentScrum.draft.selectedWorkIds ?? []), ...(currentScrum.draft.selectedYesterdayWorkIds ?? [])].some((key) => !isDailyTaskKey(key));
    if ((notesDirty || !currentScrum.draft.id || hasContainerSelections) && !await save(false)) return;
    setSaving("submit");
    try {
      const response = await fetch("/api/daily-scrum/submit", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ date, requestId: submitRequestId.current }) });
      const result = await response.json() as { error?: string; submission?: DailySubmission };
      if (!response.ok) throw new Error(apiError(result, "데일리를 확정하지 못했습니다."));
      submitRequestId.current = crypto.randomUUID();
      await reload(); onNotice(isRevision
        ? t("데일리 수정 내용을 반영했습니다. 기존 Slack 공유를 업데이트하고 있습니다.")
        : result.submission?.newlyCompletedCount
          ? t("데일리를 확정하고 업무 {count}개를 완료 처리했습니다.", { count: result.submission.newlyCompletedCount })
          : t("데일리를 확정했습니다. Slack 공유는 백그라운드에서 진행됩니다."));
    } catch (error) { onNotice(error instanceof Error ? error.message : t("데일리를 확정하지 못했습니다.")); }
    finally { setSaving(null); }
  }
  async function reload() {
    const refreshed = await fetch(`/api/daily-scrum?date=${date}`).then((entry) => entry.json() as Promise<DailyDashboard>);
    const key = `daily:${workspaceId}:${date}`; dailyScrumMemoryCache.set(key, refreshed); markViewCacheFresh(key); setScrum(refreshed); setSavedNotes(scrumNotesSnapshot(refreshed)); return refreshed;
  }
  async function createDailyTask(event: FormEvent) {
    event.preventDefault(); if (!newTaskTitle.trim() || !newTaskParent) return;
    if (await createTaskForDaily(newTaskParent, newTaskTitle, crypto.randomUUID())) {
      setNewTaskTitle(""); onNotice(t("오늘 기한의 Task를 만들고 데일리에 선택했습니다."));
    }
  }
  async function createTaskForDaily(parent: string, title: string, requestId: string) {
    if (currentScrum.member.role === "viewer") return false;
    if ((notesDirty || !currentScrum.draft.id) && !await save(false)) return false;
    setSaving("task");
    try {
      const [parentKind, parentId = ""] = parent.split(":", 2);
      const response = await fetch("/api/daily-scrum/tasks", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ date, title, parentKind, parentId: parentId || null, requestId }) });
      const result = await response.json() as { error?: string; task: { title: string } }; if (!response.ok) throw new Error(apiError(result, "Task를 만들지 못했습니다."));
      await reload(); return result.task.title;
    } catch (error) { onNotice(error instanceof Error ? error.message : t("Task를 만들지 못했습니다.")); return false; }
    finally { setSaving(null); }
  }
  function updateDraft(patch: Partial<DailyDashboard["draft"]>) { setScrum({ ...currentScrum, draft: { ...currentScrum.draft, ...patch } }); }
  function selectWork(selectedWorkIds: string[]) {
    updateDraft({ selectedWorkIds, selectedTaskIds: selectedWorkIds.filter((key) => key.startsWith("task:")).map((key) => key.slice(5)), noPlannedTasks: false, skipReason: null, skipNote: "" });
  }
  function selectYesterdayWork(selectedYesterdayWorkIds: string[]) {
    updateDraft({ selectedYesterdayWorkIds, skipReason: null, skipNote: "" });
  }
  function openWork(work: DailyWork) {
    if (work.kind === "task") onOpenTask(work.id);
    else if (work.kind === "project") onOpenProject(work.id);
    else onNavigate("routines");
  }
  function toggleSkip(checked: boolean) {
    updateDraft(checked
      ? { skipReason: currentScrum.draft.skipReason ?? "workload", selectedTaskIds: [], selectedWorkIds: [], selectedYesterdayWorkIds: [], noPlannedTasks: false }
      : { skipReason: null, skipNote: "" });
  }
  const isSkipped = Boolean(currentScrum.draft.skipReason);
  const skipNeedsNote = currentScrum.draft.skipReason === "other" && !currentScrum.draft.skipNote.trim();
  const selectedWorkIds = (currentScrum.draft.selectedWorkIds ?? currentScrum.draft.selectedTaskIds.map((id) => `task:${id}`)).filter(isDailyTaskKey);
  const selectedYesterdayWorkIds = (currentScrum.draft.selectedYesterdayWorkIds ?? []).filter(isDailyTaskKey);
  const conflictKeys = selectedYesterdayWorkIds.filter((key) => selectedWorkIds.includes(key));
  const isRevision = Boolean(currentScrum.latestSubmission);
  const revisionChanged = dailyRevisionChanged(currentScrum.draft, currentScrum.latestSubmission);
  const work = currentScrum.candidates.work ?? currentScrum.candidates.tasks.map((task): DailyWork => ({ ...task, key: `task:${task.id}`, kind: "task", priority: "medium" }));
  const yesterdayWork = (currentScrum.candidates.yesterdayWork ?? []).filter((entry) => entry.kind === "task");
  return <section className="daily-workspace">
    <div className="scrum-toolbar">
      <label><CalendarDays size={14} /><span className="sr-only">{t("데일리 날짜")}</span><input aria-label={t("데일리 날짜")} type="date" value={date} onChange={(event) => { const nextDate = event.target.value; const cached = dailyScrumMemoryCache.get(`daily:${workspaceId}:${nextDate}`) ?? null; submitRequestId.current = crypto.randomUUID(); setScrum(cached); setSavedNotes(cached ? scrumNotesSnapshot(cached) : ""); setLoadError(false); setDate(nextDate); }} /></label>
      <div><button onClick={() => void save()} disabled={Boolean(saving) || !notesDirty}>{saving === "draft" ? t("저장 중") : notesDirty ? t("초안 저장") : t("저장됨")}</button><button className="primary-action" onClick={() => void submit()} disabled={Boolean(saving) || skipNeedsNote || conflictKeys.length > 0 || isRevision && !revisionChanged}><Send size={14} />{saving === "submit" ? isRevision ? t("수정 반영 중") : t("확정 중") : isRevision ? revisionChanged ? t("수정 반영 및 다시 공유") : t("변경사항 없음") : isSkipped ? t("스킵 확정 및 공유") : t("확정 및 공유")}</button></div>
    </div>
    <div className="daily-layout"><section className="daily-editor" aria-labelledby="my-daily-heading"><header><div><h2 id="my-daily-heading">{t("내 데일리")}</h2><p>{currentScrum.latestSubmission ? t("항목을 추가하거나 빼고 다시 공유하면 기존 Slack 메시지가 업데이트됩니다.") : t("조회와 선택은 Task 상태·기한·담당자를 바꾸지 않습니다.")}</p></div>{currentScrum.latestSubmission && <small>{currentScrum.latestSubmission.skipReason ? t("스킵") : t("제출")} v{currentScrum.latestSubmission.version} · {formatDateTime(currentScrum.latestSubmission.submittedAt)}</small>}</header>
      <DailyWorkPicker label={t("완료한 일")} work={yesterdayWork} selected={selectedYesterdayWorkIds} disabled={isSkipped || Boolean(saving)} yesterday conflictKeys={conflictKeys} onChange={selectYesterdayWork} onOpen={openWork} />
      <DailyWorkPicker key={`${workspaceId}:${date}`} label={t("오늘 할 일")} work={work} containers={[...currentScrum.createTargets.projects.map((project) => ({ ...project, kind: "project" as const })), ...currentScrum.createTargets.routines.map((routine) => ({ ...routine, kind: "routine" as const }))]} selected={selectedWorkIds} disabled={isSkipped || Boolean(saving) || currentScrum.member.role === "viewer"} noPlanned={currentScrum.draft.noPlannedTasks} conflictKeys={conflictKeys} onChange={selectWork} onNoPlanned={(value) => updateDraft({ noPlannedTasks: value, selectedTaskIds: value ? [] : currentScrum.draft.selectedTaskIds, selectedWorkIds: value ? [] : selectedWorkIds })} onOpen={openWork} onCreate={(parentKey, title, requestId) => createTaskForDaily(parentKey, title, requestId)} />
      <fieldset className={`daily-skip-panel ${isSkipped ? "active" : ""}`}>
        <legend className="sr-only">{t("오늘 데일리 스킵")}</legend>
        <label className="daily-skip-toggle" htmlFor="daily-skip-toggle"><input id="daily-skip-toggle" type="checkbox" aria-label={t("오늘은 데일리를 스킵합니다")} aria-controls={isSkipped ? "daily-skip-fields" : undefined} checked={isSkipped} onChange={(event) => toggleSkip(event.target.checked)} /><span><b>{t("오늘은 데일리를 스킵합니다")}</b><small>{t("확정하면 선택한 사유가 팀과 Slack 채널에 공유됩니다.")}</small></span></label>
        {isSkipped && <div id="daily-skip-fields" className="daily-skip-fields"><label><span>{t("스킵 사유")}</span><select aria-label={t("데일리 스킵 사유")} value={currentScrum.draft.skipReason ?? "workload"} onChange={(event) => updateDraft({ skipReason: event.target.value as DailySkipReason, skipNote: event.target.value === "other" ? currentScrum.draft.skipNote : "" })}><option value="workload">{t("본업 과중")}</option><option value="vacation">{t("휴가")}</option><option value="personal">{t("개인 일정")}</option><option value="other">{t("기타")}</option></select></label><label><span>{t("상세 사유")}{currentScrum.draft.skipReason === "other" ? t("(필수)") : t("(선택)")}</span><input aria-label={t("데일리 스킵 상세 사유")} aria-required={currentScrum.draft.skipReason === "other"} required={currentScrum.draft.skipReason === "other"} value={currentScrum.draft.skipNote} onChange={(event) => updateDraft({ skipNote: event.target.value })} maxLength={500} placeholder={t("팀에 공유할 보충 설명")} /></label></div>}
        {skipNeedsNote && <p role="alert">{t("기타 스킵 사유를 입력해 주세요.")}</p>}
      </fieldset>
      <div className="daily-notes"><label><span>{t("완료 메모")}</span><textarea disabled={Boolean(saving)} value={currentScrum.draft.yesterdayNote} onChange={(event) => updateDraft({ yesterdayNote: event.target.value })} placeholder={t("완료한 일에 대한 메모")} /></label><label><span>{t("오늘 메모")}</span><textarea disabled={Boolean(saving)} value={currentScrum.draft.todayNote} onChange={(event) => updateDraft({ todayNote: event.target.value })} placeholder={t("오늘의 초점과 메모")} /></label><label><span>{t("블로커")}</span><textarea disabled={Boolean(saving)} value={currentScrum.draft.blockersNote} onChange={(event) => updateDraft({ blockersNote: event.target.value })} placeholder={t("도움이 필요한 문제")} /></label></div>
      <details className="daily-legacy"><summary>{t("새 Task 추가")}</summary><form className={`daily-new-task ${isSkipped ? "daily-work-disabled" : ""}`} onSubmit={(event) => void createDailyTask(event)}><header><b>{t("새 Task 만들기")}</b><span>{isSkipped ? t("스킵을 해제하면 Task를 만들 수 있습니다.") : t("이 양식을 제출할 때만 실제 Task가 생성됩니다.")}</span></header><div><select aria-label={t("새 Task 상위 항목")} disabled={isSkipped} value={newTaskParent} onChange={(event) => setNewTaskParent(event.target.value)}>{currentScrum.createTargets.projects.map((project) => <option key={project.id} value={`project:${project.id}`}>Project · {project.title}</option>)}{currentScrum.createTargets.routines.map((routine) => <option key={routine.id} value={`routine:${routine.id}`}>Routine · {routine.title}</option>)}{currentScrum.createTargets.allowGeneral && <option value="general:">General</option>}</select><input aria-label={t("새 Task 제목")} disabled={isSkipped} value={newTaskTitle} onChange={(event) => setNewTaskTitle(event.target.value)} maxLength={240} placeholder={t("오늘 할 Task 제목")} /><button disabled={isSkipped || !newTaskTitle.trim() || !newTaskParent || Boolean(saving)}>{saving === "task" ? t("생성 중") : t("Task 생성")}</button></div></form></details>
    </section><section className="daily-rollup" aria-labelledby="daily-rollup-heading"><header><h2 id="daily-rollup-heading">{t("팀 데일리")}</h2><p>{t("작성 중인 초안은 상태만 표시하고, 확정된 스킵 사유만 공개합니다.")}</p></header><div>{currentScrum.team.map((member) => <article key={member.memberId} className={`daily-member-card ${member.status}`}><header><div><b>{member.displayName}</b><small>{member.slackConnected ? t("Slack 연결") : t("Slack 미연결")}</small></div><span>{member.status === "skipped" ? t("스킵") : member.status === "submitted" ? t("제출 완료") : member.status === "writing" ? t("작성 중") : t("미제출")}</span></header>{member.submission ? member.submission.skipReason ? <div className="daily-skip-summary"><b>{t("오늘 데일리 스킵")}</b><span>{t("사유 ·")}{dailySkipLabel(member.submission.skipReason)}</span>{member.submission.skipNote && <p>{member.submission.skipNote}</p>}</div> : <DailySubmissionSummary submission={member.submission} onOpenTask={onOpenTask} onOpenWork={openWork} /> : <p className="daily-private-draft">{member.status === "writing" ? t("초안을 작성 중입니다. 내용은 제출 후 공개됩니다.") : t("아직 제출된 데일리가 없습니다.")}</p>}</article>)}</div>{currentScrum.legacyWorkspaceNote && <details className="daily-legacy"><summary>{t("기존 워크스페이스 메모")}</summary><p>{currentScrum.legacyWorkspaceNote.todayNote || currentScrum.legacyWorkspaceNote.yesterdayNote || currentScrum.legacyWorkspaceNote.blockersNote}</p></details>}</section></div>
  </section>;
}

function DailySubmissionSummary({ submission, onOpenTask, onOpenWork }: { submission: DailySubmission; onOpenTask: (id: string) => void; onOpenWork: (work: DailyWork) => void }) {
  const completedWork = [...new Map([...(submission.yesterdayWork ?? []), ...(submission.work?.filter((entry) => entry.completedToday) ?? [])].map((entry) => [entry.key, entry])).values()];
  const plannedWork = submission.work?.filter((entry) => !entry.completedToday) ?? [];
  const parentContext = (parentKind: string | undefined, parentTitle: string) => parentKind === "project"
    ? `${t("Project")} · ${parentTitle}`
    : parentKind === "routine" ? `${t("Routine")} · ${parentTitle}` : parentTitle;
  const workContext = (entry: DailyWork) => entry.kind === "task"
    ? parentContext(entry.parentKind, entry.parentTitle)
    : `${entry.kind === "project" ? t("Project") : t("Routine")} · ${entry.parentTitle}`;
  return <div className="daily-submission-summary">
    <b>{t("완료한 일")}</b>
    <ul aria-label={t("완료한 일")}>{completedWork.length ? completedWork.map((entry) => <li className="daily-submission-work" key={entry.key}><small>{workContext(entry)}</small><span className="daily-submission-task"><button onClick={() => onOpenWork(entry)}>{entry.title}</button></span></li>) : <li>{t("선택한 업무 없음")}</li>}</ul>
    {submission.yesterdayNote && <p><b>{t("완료 메모")}</b>{submission.yesterdayNote}</p>}
    <b>{t("오늘 할 일")}</b>
    <ul aria-label={t("오늘 할 일")}>{submission.tasks.map((task) => <li className="daily-submission-work" key={task.id}><small>{parentContext(task.parentKind, task.parentTitle)}</small><span className="daily-submission-task">{task.isNew && <em>{t("신규")}</em>}<button disabled={!task.taskId} onClick={() => task.taskId && onOpenTask(task.taskId)}>{task.taskTitle}</button></span></li>)}{plannedWork.map((entry) => <li className="daily-submission-work" key={entry.key}><small>{workContext(entry)}</small><span className="daily-submission-task"><button onClick={() => onOpenWork(entry)}>{entry.title}</button></span></li>)}{!submission.tasks.length && !plannedWork.length && <li>{t("오늘 예정 없음")}</li>}</ul>
    {submission.todayNote && <p><b>{t("오늘 메모")}</b>{submission.todayNote}</p>}
    {submission.blockersNote && <p className="blocker"><b>{t("블로커")}</b>{submission.blockersNote}</p>}
  </div>;
}

function defaultDailyParent(scrum: DailyDashboard) { const project = scrum.createTargets.projects.find((entry) => entry.needsTask) ?? scrum.createTargets.projects[0]; if (project) return `project:${project.id}`; if (scrum.createTargets.routines[0]) return `routine:${scrum.createTargets.routines[0].id}`; return scrum.createTargets.allowGeneral ? "general:" : ""; }

function RecommendationsView({ workspaceId, items, onOpenTask, onOpenProject, onNavigate }: { workspaceId: string; items: OkriItem[]; onOpenTask: (id: string) => void; onOpenProject: (id: string) => void; onNavigate: (view: View) => void }) {
  const date = localDate();
  const cacheKey = `recommendations:${workspaceId}:${date}`;
  const [rows, setRows] = useState<Recommendation[] | null>(() => recommendationMemoryCache.get(cacheKey) ?? null);
  const [loadError, setLoadError] = useState(false);
  const [loadAttempt, setLoadAttempt] = useState(0);
  useEffect(() => {
    let active = true;
    const cachedRows = recommendationMemoryCache.get(cacheKey) ?? null;
    if (cachedRows && viewCacheIsFresh(cacheKey)) return () => { active = false; };
    fetch(`/api/recommendations?date=${date}`)
      .then(async (response) => response.ok ? response.json() as Promise<{ recommendations: Recommendation[] }> : Promise.reject())
      .then((data) => { if (active) { recommendationMemoryCache.set(cacheKey, data.recommendations); markViewCacheFresh(cacheKey); setLoadError(false); setRows(data.recommendations); } })
      .catch(() => { if (active && !cachedRows) setLoadError(true); });
    return () => { active = false; };
  }, [cacheKey, date, loadAttempt]);
  if (loadError) return <AsyncState icon={AlertTriangle} title={t("추천을 계산하지 못했습니다")} detail={t("워크스페이스 데이터를 다시 확인해 주세요.")} actionLabel={t("다시 시도")} onAction={() => { setRows(null); setLoadError(false); setLoadAttempt((attempt) => attempt + 1); }} />;
  if (!rows) return <AsyncState icon={LoaderCircle} title={t("추천을 계산하는 중입니다")} loading />;
  if (!rows.length) return <EmptyState icon={CheckCircle2} title={t("지금 바로 정리할 항목이 없습니다")} />;
  function openRecommendation(row: Recommendation) {
    const target = row.itemIds.map((id) => items.find((item) => item.id === id)).find(Boolean);
    if (target?.kind === "task") onOpenTask(target.id);
    else if (target?.kind === "project") onOpenProject(target.id);
    else onNavigate(row.kind === "empty_project" ? "okr" : "work");
  }
  return <section className="recommendation-list">{rows.map((row) => <article className="recommendation-row" key={row.id}><span className={`recommendation-icon recommendation-${row.kind}`}>{recommendationIcon(row.kind)}</span><div><h3>{row.title}</h3><p>{row.detail}</p><small>{t("{count}개 항목 · 우선순위 {score}", { count: row.itemIds.length, score: row.score })}</small></div><button aria-label={t("{value1} 관련 항목 열기", { value1: messageValue(row.title) })} title={t("관련 항목 열기")} onClick={() => openRecommendation(row)}><ChevronRight size={15} /></button></article>)}</section>;
}

function HomeView({ onCreatePlan, onCreateProject, onCreateRoutine, onApplyOkrPlan, onCreateTasks, onStartTaskCreation, onFinish, onNavigateToOkr, context, usageScope, workspaceContext, canWrite, members, taskContainers, projectTargets, defaultDriMemberId, defaultCycleId }: {
  usageScope: AiUsageScope | null;
  onCreatePlan: (plan: OnboardingPlan, cycleId: string | null) => Promise<PlanCreationResult | null>;
  onCreateProject: (plan: OnboardingPlan, target: ProjectChatTarget, driMemberId: string | null) => Promise<boolean>;
  onCreateRoutine: (plan: OnboardingPlan, assigneeMemberId: string | null) => Promise<boolean>;
  onApplyOkrPlan: (plan: OnboardingPlan, cycleId: string, target: OkrPlanTarget | null, driMemberId: string | null) => Promise<OkrPlanApplyResult | null>;
  onCreateTasks: (taskText: string, containerValue: string, assigneeMemberId: string | null) => Promise<boolean>;
  onStartTaskCreation: () => void;
  onFinish: () => void;
  onNavigateToOkr: () => void;
  context: OkrChatContext | null;
  workspaceContext: AssistantWorkspaceContext;
  canWrite: boolean;
  members: TeamMember[];
  taskContainers: TaskContainerOption[];
  projectTargets: ProjectChatTarget[];
  defaultDriMemberId: string | null;
  defaultCycleId: string | null;
}) {
  return (
    <div className="home-layout">
      <HomeOkrChat onCreate={onCreatePlan} onCreateProject={onCreateProject} onCreateRoutine={onCreateRoutine} onApplyOkrPlan={onApplyOkrPlan} onCreateTasks={onCreateTasks} onStartTaskCreation={onStartTaskCreation} onFinish={onFinish} onNavigateToOkr={onNavigateToOkr} context={context} usageScope={usageScope} workspaceContext={workspaceContext} canWrite={canWrite} members={members} taskContainers={taskContainers} projectTargets={projectTargets} defaultDriMemberId={defaultDriMemberId} defaultCycleId={defaultCycleId} />
    </div>
  );
}

function isAssistantConversationDraft(value: unknown): value is AssistantConversationDraft {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const draft = value as Partial<AssistantConversationDraft>;
  const plan = draft.plan as Partial<OnboardingPlan> | undefined;
  return draft.version === 1
    && typeof draft.message === "string"
    && Boolean(plan)
    && typeof plan?.objectiveTitle === "string"
    && Array.isArray(plan?.keyResults)
    && Array.isArray(plan?.targetInitiatives)
    && Array.isArray(plan?.unassignedInitiatives)
    && typeof plan?.project === "string"
    && typeof plan?.tasks === "string"
    && Array.isArray(draft.guideQuestions)
    && Array.isArray(draft.conversationHistory)
    && Array.isArray(draft.visibleFields)
    && (["okr", "project", "routine", "task", "onboarding", "coach"] as unknown[]).includes(draft.mode)
    && Array.isArray(draft.targetCandidates);
}

function HomeOkrChat({ onCreate, onCreateProject, onCreateRoutine, onApplyOkrPlan, onCreateTasks, onStartTaskCreation, onFinish, onNavigateToOkr, context, usageScope, workspaceContext, canWrite, members, taskContainers, projectTargets, defaultDriMemberId, defaultCycleId }: {
  usageScope: AiUsageScope | null;
  onCreate: (plan: OnboardingPlan, cycleId: string | null) => Promise<PlanCreationResult | null>;
  onCreateProject: (plan: OnboardingPlan, target: ProjectChatTarget, driMemberId: string | null) => Promise<boolean>;
  onCreateRoutine: (plan: OnboardingPlan, assigneeMemberId: string | null) => Promise<boolean>;
  onApplyOkrPlan: (plan: OnboardingPlan, cycleId: string, target: OkrPlanTarget | null, driMemberId: string | null) => Promise<OkrPlanApplyResult | null>;
  onCreateTasks: (taskText: string, containerValue: string, assigneeMemberId: string | null) => Promise<boolean>;
  onStartTaskCreation: () => void;
  onFinish: () => void;
  onNavigateToOkr: () => void;
  context: OkrChatContext | null;
  workspaceContext: AssistantWorkspaceContext;
  canWrite: boolean;
  members: TeamMember[];
  taskContainers: TaskContainerOption[];
  projectTargets: ProjectChatTarget[];
  defaultDriMemberId: string | null;
  defaultCycleId: string | null;
}) {
  const [aiUsageRevision, setAiUsageRevision] = useState(0);
  const emptyPlan: OnboardingPlan = {
    objectiveTitle: "",
    keyResults: [],
    targetInitiatives: [],
    unassignedInitiatives: [],
    project: "",
    tasks: "",
    taskParent: "",
    routineTitle: "",
    routineTrigger: "",
    routinePlace: "",
    routineSteps: "",
    routineCadence: "daily",
  };
  const [message, setMessage] = useState(context?.initialMessage ?? "");
  const [plan, setPlan] = useState<OnboardingPlan>({
    ...emptyPlan,
  });
  const [guideQuestions, setGuideQuestions] = useState<string[]>([]);
  const [conversationHistory, setConversationHistory] = useState<ChatMessage[]>(() => [{ id: "initial", role: "assistant", content: assistantOpeningMessage() }]);
  const [visibleFields, setVisibleFields] = useState<Set<StringPlanField>>(new Set());
  const [mode, setMode] = useState<ConversationMode>(context?.entry === "onboarding" ? "onboarding" : context?.entry === "coach" ? "coach" : context?.entry === "project" ? "project" : context?.entry === "routine" ? "routine" : context?.entry === "task" ? "task" : "okr");
  const [okrTarget, setOkrTarget] = useState<OkrPlanTarget | null>(context?.target ?? null);
  const [targetCandidates, setTargetCandidates] = useState<OkrPlanTarget[]>(context?.targetCandidates ?? []);
  const [targetSearch, setTargetSearch] = useState("");
  const [referencesOpen, setReferencesOpen] = useState(false);
  const referenceButtonRef = useRef<HTMLButtonElement>(null);
  const [projectTarget, setProjectTarget] = useState<ProjectChatTarget | null>(null);
  const [projectDriMemberId, setProjectDriMemberId] = useState(defaultDriMemberId ?? members[0]?.id ?? "");
  const [routineAssigneeMemberId, setRoutineAssigneeMemberId] = useState("");
  const [taskContainer, setTaskContainer] = useState("");
  const [taskAssigneeMemberId, setTaskAssigneeMemberId] = useState("");
  const [saving, setSaving] = useState(false);
  const [draftHydrated, setDraftHydrated] = useState(false);
  const [draftSaveState, setDraftSaveState] = useState<"loading" | "idle" | "saving" | "saved" | "error">("loading");
  const draftSaveSequenceRef = useRef(0);
  const draftKey = context?.key ?? `default:${defaultCycleId ?? "none"}`;
  const assistantFlow = mode === "onboarding" || mode === "coach";
  const draftCounts = countOkrDraft(plan);
  const taskDraftCount = plan.tasks.split("\n").map((entry) => entry.trim()).filter(Boolean).length;
  const treeReady = Boolean(plan.objectiveTitle.trim() && plan.keyResults.length && plan.keyResults.every((entry) => entry.title.trim() && entry.initiatives.every((initiative) => initiative.title.trim())) && !plan.unassignedInitiatives.length);
  const visibleTargetCandidates = useMemo(() => {
    const query = targetSearch.trim().toLocaleLowerCase();
    const candidates = targetCandidates.filter((target) => target.id !== okrTarget?.id);
    if (!query) return candidates.slice(0, 12);
    return candidates.filter((target) => `${kindLabel(target.kind)} ${target.title}`.toLocaleLowerCase().includes(query)).slice(0, 12);
  }, [okrTarget?.id, targetCandidates, targetSearch]);
  const saveLabel = mode === "task" ? t("Task {value1}개 만들기", { value1: messageValue(taskDraftCount) }) : mode === "routine" ? "Routine 만들기" : assistantFlow
    ? !okrTarget ? t("Objective 1개 · KR {value1}개 · Initiative {value2}개 만들기", { value1: messageValue(draftCounts.keyResults), value2: messageValue(draftCounts.initiatives) })
      : okrTarget.kind === "objective" ? t("KR {value1}개 · Initiative {value2}개 만들기", { value1: messageValue(draftCounts.keyResults), value2: messageValue(draftCounts.initiatives) })
        : okrTarget.kind === "key_result" ? t("Initiative {value1}개 만들기", { value1: messageValue(plan.targetInitiatives.length) }) : "Project 탭에서 계속"
    : mode === "project" ? "Project 만들기" : t("Objective 1개 · KR {value1}개 · Initiative {value2}개 만들기", { value1: messageValue(draftCounts.keyResults), value2: messageValue(draftCounts.initiatives) });
  const hasDraft = hasPlanContent(plan);
  const persistedMessage = parseAssistantCommand(message) ? "" : message;
  const hasPersistableDraft = Boolean(persistedMessage.trim() || hasDraft || conversationHistory.some((entry) => entry.role === "user"));
  const assistantDraftPayload = useMemo<AssistantConversationDraft>(() => ({
    version: 1,
    message: persistedMessage,
    plan,
    guideQuestions,
    conversationHistory,
    visibleFields: [...visibleFields],
    mode,
    okrTarget,
    targetCandidates,
    projectTarget,
    projectDriMemberId,
    routineAssigneeMemberId,
    taskContainer,
    taskAssigneeMemberId,
  }), [conversationHistory, guideQuestions, mode, okrTarget, persistedMessage, plan, projectDriMemberId, projectTarget, routineAssigneeMemberId, targetCandidates, taskAssigneeMemberId, taskContainer, visibleFields]);
  const canApplyDraft = mode === "task" ? Boolean(taskDraftCount) : assistantFlow
    ? !okrTarget ? treeReady
      : okrTarget.kind === "objective" ? Boolean(plan.keyResults.length && plan.keyResults.every((entry) => entry.title.trim() && entry.initiatives.every((initiative) => initiative.title.trim())) && !plan.unassignedInitiatives.length)
        : okrTarget.kind === "key_result" ? Boolean(plan.targetInitiatives.length && plan.targetInitiatives.every((entry) => entry.title.trim()))
          : false
    : mode === "project" ? Boolean(plan.project.trim() && projectTarget) : mode === "routine" ? Boolean(plan.routineTitle.trim()) : treeReady;

  useEffect(() => {
    const controller = new AbortController();
    let active = true;
    const timeout = window.setTimeout(() => controller.abort(), 10_000);
    void fetch(`/api/assistant-drafts?key=${encodeURIComponent(draftKey)}`, { signal: controller.signal, cache: "no-store" })
      .then(async (response) => {
        if (!response.ok) throw new Error("draft load failed");
        return response.json() as Promise<{ draft?: { payload?: AssistantConversationDraft } | null }>;
      })
      .then((data) => {
        if (!active) return;
        if (!isAssistantConversationDraft(data.draft?.payload)) {
          setDraftSaveState("idle");
          return;
        }
        const restored = data.draft.payload;
        setMessage(restored.message);
        setPlan(restored.plan);
        const hasUserConversation = restored.conversationHistory.some((entry) => entry.role === "user");
        setGuideQuestions(hasUserConversation ? restored.guideQuestions : []);
        setConversationHistory(hasUserConversation ? restored.conversationHistory : [{ id: "initial", role: "assistant", content: assistantOpeningMessage() }]);
        setVisibleFields(new Set(restored.visibleFields));
        setMode(restored.mode);
        setOkrTarget(restored.okrTarget);
        setTargetCandidates(restored.targetCandidates);
        setProjectTarget(restored.projectTarget && projectTargets.some((entry) => entry.initiativeId === restored.projectTarget?.initiativeId) ? restored.projectTarget : null);
        setProjectDriMemberId(members.some((member) => member.id === restored.projectDriMemberId) ? restored.projectDriMemberId : defaultDriMemberId ?? members[0]?.id ?? "");
        setRoutineAssigneeMemberId(members.some((member) => member.id === restored.routineAssigneeMemberId) ? restored.routineAssigneeMemberId : "");
        setTaskContainer(taskContainers.some((entry) => `${entry.kind}:${entry.id}` === restored.taskContainer) ? restored.taskContainer : "");
        setTaskAssigneeMemberId(members.some((member) => member.id === restored.taskAssigneeMemberId) ? restored.taskAssigneeMemberId : "");
        setDraftSaveState("saved");
      })
      .catch(() => {
        if (active && !controller.signal.aborted) setDraftSaveState("error");
      })
      .finally(() => {
        window.clearTimeout(timeout);
        if (active) setDraftHydrated(true);
      });
    return () => {
      active = false;
      window.clearTimeout(timeout);
      controller.abort();
    };
    // The view is keyed by draft context, so restoring runs once for that context.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draftKey]);

  useEffect(() => {
    if (!draftHydrated || !hasPersistableDraft) return;
    const sequence = ++draftSaveSequenceRef.current;
    const controller = new AbortController();
    const timeout = window.setTimeout(() => {
      setDraftSaveState("saving");
      void fetch(`/api/assistant-drafts?key=${encodeURIComponent(draftKey)}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ payload: assistantDraftPayload }),
        signal: controller.signal,
      }).then((response) => {
        if (!response.ok) throw new Error("draft save failed");
        if (draftSaveSequenceRef.current === sequence) setDraftSaveState("saved");
      }).catch(() => {
        if (!controller.signal.aborted && draftSaveSequenceRef.current === sequence) setDraftSaveState("error");
      });
    }, 450);
    return () => {
      window.clearTimeout(timeout);
      controller.abort();
    };
  }, [assistantDraftPayload, draftHydrated, draftKey, hasPersistableDraft]);

  function clearAssistantDraft() {
    draftSaveSequenceRef.current += 1;
    setDraftSaveState("idle");
    void fetch(`/api/assistant-drafts?key=${encodeURIComponent(draftKey)}`, { method: "DELETE", keepalive: true });
  }

  function resetConversationDraft() {
    clearAssistantDraft();
    setMessage("");
    setPlan({ ...emptyPlan });
    setGuideQuestions([]);
    setConversationHistory([{ id: "initial-reset", role: "assistant", content: assistantOpeningMessage() }]);
    setVisibleFields(new Set());
    setMode(context?.entry === "onboarding" ? "onboarding" : context?.entry === "coach" ? "coach" : context?.entry === "project" ? "project" : context?.entry === "routine" ? "routine" : context?.entry === "task" ? "task" : "okr");
    setOkrTarget(context?.target ?? null);
    setTargetCandidates(context?.targetCandidates ?? []);
    setTargetSearch("");
    setReferencesOpen(false);
    setProjectTarget(null);
    setProjectDriMemberId(defaultDriMemberId ?? members[0]?.id ?? "");
    setRoutineAssigneeMemberId("");
    setTaskContainer("");
    setTaskAssigneeMemberId("");
  }
  function setAssistantResponse(value: string) {
    setConversationHistory((current) => [...current, { id: `assistant-${Date.now()}-${current.length}`, role: "assistant", content: value }]);
  }
  function patch(field: StringPlanField, value: string) {
    setVisibleFields((current) => new Set(current).add(field));
    setPlan((current) => ({ ...current, [field]: value }));
  }
  function hasPlanContent(value: OnboardingPlan) {
    return Boolean(value.objectiveTitle.trim() || value.keyResults.length || value.targetInitiatives.length || value.unassignedInitiatives.length || planStringFieldsWithValues(value).length);
  }
  function patchObjective(value: string) {
    setPlan((current) => ({ ...current, objectiveTitle: value }));
  }
  function addKeyResult() {
    setPlan((current) => ({ ...current, keyResults: [...current.keyResults, { clientId: createDraftClientId("kr"), title: "", initiatives: [] }] }));
  }
  function patchKeyResult(clientId: string, title: string) {
    setPlan((current) => ({ ...current, keyResults: current.keyResults.map((entry) => entry.clientId === clientId ? { ...entry, title } : entry) }));
  }
  function removeKeyResult(clientId: string) {
    setPlan((current) => {
      const removed = current.keyResults.find((entry) => entry.clientId === clientId);
      return {
        ...current,
        keyResults: current.keyResults.filter((entry) => entry.clientId !== clientId),
        unassignedInitiatives: [...current.unassignedInitiatives, ...(removed?.initiatives ?? [])],
      };
    });
  }
  function addInitiative(keyResultId?: string) {
    const initiative = { clientId: createDraftClientId("initiative"), title: "" };
    setPlan((current) => keyResultId
      ? { ...current, keyResults: current.keyResults.map((entry) => entry.clientId === keyResultId ? { ...entry, initiatives: [...entry.initiatives, initiative] } : entry) }
      : { ...current, targetInitiatives: [...current.targetInitiatives, initiative] });
  }
  function patchInitiative(clientId: string, title: string) {
    setPlan((current) => ({
      ...current,
      keyResults: current.keyResults.map((entry) => ({ ...entry, initiatives: entry.initiatives.map((initiative) => initiative.clientId === clientId ? { ...initiative, title } : initiative) })),
      targetInitiatives: current.targetInitiatives.map((entry) => entry.clientId === clientId ? { ...entry, title } : entry),
      unassignedInitiatives: current.unassignedInitiatives.map((entry) => entry.clientId === clientId ? { ...entry, title } : entry),
    }));
  }
  function removeInitiative(clientId: string) {
    setPlan((current) => ({
      ...current,
      keyResults: current.keyResults.map((entry) => ({ ...entry, initiatives: entry.initiatives.filter((initiative) => initiative.clientId !== clientId) })),
      targetInitiatives: current.targetInitiatives.filter((entry) => entry.clientId !== clientId),
      unassignedInitiatives: current.unassignedInitiatives.filter((entry) => entry.clientId !== clientId),
    }));
  }
  function moveInitiative(clientId: string, targetKeyResultId: string) {
    setPlan((current) => {
      const allInitiatives = [
        ...current.keyResults.flatMap((entry) => entry.initiatives),
        ...current.unassignedInitiatives,
      ];
      const moving = allInitiatives.find((entry) => entry.clientId === clientId);
      if (!moving) return current;
      return {
        ...current,
        keyResults: current.keyResults.map((entry) => ({
          ...entry,
          initiatives: entry.clientId === targetKeyResultId
            ? [...entry.initiatives.filter((initiative) => initiative.clientId !== clientId), moving]
            : entry.initiatives.filter((initiative) => initiative.clientId !== clientId),
        })),
        unassignedInitiatives: current.unassignedInitiatives.filter((entry) => entry.clientId !== clientId),
      };
    });
  }
  async function organizeMessage() {
    const text = message.trim();
    if (!text || saving) return;
    if (parseAssistantCommand(text) === "create-task") {
      setMessage("");
      onStartTaskCreation();
      return;
    }
    setConversationHistory((current) => [...current, { id: `user-${Date.now()}`, role: "user", content: text }]);
    setMessage("");
    setSaving(true);
    try {
      const response = await fetch("/api/okr-organize", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          message: text,
          plan,
          mode,
          history: conversationHistory.slice(-10).map(({ role, content }) => ({ role, content })),
          workspaceContext,
          parentContext: { initiativeTitle: projectTarget?.initiativeTitle, target: okrTarget },
        }),
      });
      const data = await response.json() as ({ organized: OrganizedOkr } & OrganizeError);
      if (!response.ok) {
        if (data.code?.startsWith("ai_")) {
          setAssistantResponse(aiLimitMessage(data));
          setGuideQuestions(data.options?.length ? data.options : ["유료 플랜으로 서버 AI 정리 계속 사용", "개인 OpenAI API 키 연결", "ChatGPT에서 OKRI MCP로 연결해 직접 정리"]);
          return;
        }
        throw new Error("organize failed");
      }
      setPlan(data.organized.plan);
      setVisibleFields((current) => new Set([...current, ...planStringFieldsWithValues(data.organized.plan)]));
      setAssistantResponse(data.organized.assistantMessage);
      setGuideQuestions(data.organized.questions);
    } catch {
      setAssistantResponse("지금은 답변을 불러오지 못했습니다. 작성 중인 초안은 그대로 두었습니다. 잠시 후 다시 보내 주세요.");
      setGuideQuestions([]);
    } finally {
      setSaving(false);
      invalidateAiUsage();
      setAiUsageRevision((revision) => revision + 1);
    }
  }
  function chooseTarget(target: OkrPlanTarget) {
    setOkrTarget(target);
    setTargetSearch("");
    setReferencesOpen(false);
    setPlan({ ...emptyPlan });
    setVisibleFields(new Set());
    setMode("coach");
    setAssistantResponse(targetPrompt(target));
    setGuideQuestions([]);
  }
  function closeReferencesOnEscape(event: ReactKeyboardEvent<HTMLElement>) {
    if (event.key !== "Escape") return;
    event.stopPropagation();
    setReferencesOpen(false);
    referenceButtonRef.current?.focus();
  }
  function chooseQuickReply(question: string) {
    if (question.includes("나중에")) {
      skipOptionalStep();
      return;
    }
    const starter = question === "업무 목표를 말해볼게요" ? "이번 분기에 업무에서 이루고 싶은 목표는 "
      : question === "개인 성장 목표를 말해볼게요" ? "이번 분기에 개인적으로 이루고 싶은 목표는 "
        : question;
    setMessage(starter);
  }
  async function save() {
    if (mode === "task") {
      if (!canWrite || !canApplyDraft) return;
      setSaving(true);
      const created = await onCreateTasks(plan.tasks, taskContainer, taskAssigneeMemberId || null);
      setSaving(false);
      if (created) {
        clearAssistantDraft();
        setPlan({ ...emptyPlan });
        setVisibleFields(new Set());
        onFinish();
      }
      return;
    }
    if (assistantFlow) {
      if (!canWrite || !canApplyDraft) return;
      const cycleId = context?.cycleId ?? defaultCycleId;
      if (!cycleId) return;
      setSaving(true);
      const result = await onApplyOkrPlan(plan, cycleId, okrTarget, null);
      setSaving(false);
      if (!result) return;
      setPlan({ ...emptyPlan });
      setVisibleFields(new Set());
      setGuideQuestions([]);
      setTargetCandidates([]);
      const createdInitiatives = result.items.filter((entry) => result.initiativeIds.includes(entry.id));
      if (createdInitiatives.length) {
        clearAssistantDraft();
        setAssistantResponse("OKR 구조를 저장했습니다. 실행 계획은 Project 탭에서 Initiative를 선택해 만들어 주세요.");
        onFinish();
        return;
      }
      const createdKeyResults = result.items.filter((entry) => result.keyResultIds.includes(entry.id));
      if (createdKeyResults.length === 1) {
        const keyResult = createdKeyResults[0];
        setOkrTarget({ id: keyResult.id, kind: "key_result", title: keyResult.title });
        setMode("coach");
        setAssistantResponse("OKR을 만들었습니다. 이제 이 Key Result를 움직일 Initiative도 정해볼까요? 아직 생각나지 않았다면 건너뛸 수 있습니다.");
        setGuideQuestions(["Initiative를 정리할게요", "나중에 할게요"]);
        return;
      }
      if (createdKeyResults.length > 1) {
        setOkrTarget(null);
        setTargetCandidates(createdKeyResults.map((entry) => ({ id: entry.id, kind: "key_result", title: entry.title })));
        setMode("coach");
        setAssistantResponse("OKR을 만들었습니다. Initiative를 이어서 정리할 Key Result를 선택해 주세요.");
        return;
      }
      clearAssistantDraft();
      onFinish();
      return;
    }
    if (mode === "project") {
      if (!plan.project.trim()) {
        await organizeMessage();
        return;
      }
      if (!projectTarget) return;
      setSaving(true);
      const created = await onCreateProject(plan, projectTarget, projectDriMemberId || null);
      setSaving(false);
      if (created) {
        clearAssistantDraft();
        setPlan({ ...emptyPlan });
        setVisibleFields(new Set());
        setProjectTarget(null);
      }
      return;
    }
    if (mode === "routine") {
      if (!plan.routineTitle.trim()) {
        await organizeMessage();
        return;
      }
      setSaving(true);
      const created = await onCreateRoutine(plan, routineAssigneeMemberId || null);
      setSaving(false);
      if (created) {
        clearAssistantDraft();
        setPlan({ ...emptyPlan });
        setVisibleFields(new Set());
      }
      return;
    }
    if (!plan.objectiveTitle.trim()) {
      await organizeMessage();
      return;
    }
    setSaving(true);
    const created = await onCreate(plan, context?.cycleId ?? defaultCycleId);
    setSaving(false);
    if (created) {
      clearAssistantDraft();
      setMessage("");
      setPlan({ ...emptyPlan });
      setGuideQuestions([]);
      setVisibleFields(new Set());
      setTargetCandidates([]);
      setProjectTarget(null);
      setAssistantResponse("OKR 구조를 저장했습니다. 실행 계획은 Project 탭에서 Initiative를 선택해 만들어 주세요.");
    }
  }
  function skipOptionalStep() {
    clearAssistantDraft();
    setAssistantResponse("좋아요. 지금은 여기까지 저장했습니다. Initiative나 Project가 떠오르면 언제든 OKR 도우미를 다시 불러 주세요.");
    setPlan({ ...emptyPlan });
    setVisibleFields(new Set());
    setGuideQuestions([]);
    onFinish();
  }
  return (
    <section className="home-okr-chat" aria-labelledby="home-okr-chat-title">
      <header>
        <div><Bot size={16} /><h2 id="home-okr-chat-title">{t("AI 대화")}</h2></div>
        <div className="assistant-chat-header-actions">
          <span className={`assistant-draft-status ${draftSaveState}`} aria-live="polite">{draftSaveState === "loading" ? <><LoaderCircle className="spin" size={12} />{t("이전 초안 확인 중")}</> : draftSaveState === "saving" ? <><LoaderCircle className="spin" size={12} />{t("임시저장 중")}</> : draftSaveState === "saved" ? <><CheckCircle2 size={12} />{t("임시저장됨")}</> : draftSaveState === "error" ? <><AlertTriangle size={12} />{t("임시저장 재시도 예정")}</> : null}</span>
          {hasPersistableDraft && <button type="button" className="assistant-reset-draft" onClick={resetConversationDraft}>{t("새로 시작")}</button>}
          {targetCandidates.length > 0 && <button ref={referenceButtonRef} type="button" className="icon-button" aria-label={t("참고 항목 선택")} title={t("참고 항목 선택")} aria-expanded={referencesOpen} aria-controls={referencesOpen ? "assistant-references" : undefined} onKeyDown={closeReferencesOnEscape} onClick={() => setReferencesOpen((open) => !open)}><Link2 size={15} /></button>}
        </div>
      </header>
      <div className="home-chat-surface">
        {usageScope && <ChatAiUsage scope={usageScope} refreshKey={aiUsageRevision} />}
        <div className="chat-thread">
          {conversationHistory.map((entry) => <p className={entry.role === "user" ? "user-message" : "assistant-message"} key={entry.id}>{entry.content}</p>)}
          {referencesOpen && targetCandidates.length > 0 && <div id="assistant-references" className="assistant-target-picker" aria-label={t("대화 대상 선택")}>
            <header>
              <div><Search size={13} /><b>{t("대화 대상")}</b></div>
              {okrTarget ? <span>{kindLabel(okrTarget.kind)} · {okrTarget.title}</span> : <span>{t("전체 OKR 문맥")}</span>}
            </header>
            <label>
              <span className="sr-only">{t("Objective, Key Result, Initiative, Project 검색")}</span>
              <input value={targetSearch} onKeyDown={closeReferencesOnEscape} onChange={(event) => setTargetSearch(event.target.value)} placeholder={t("Objective, KR, Initiative, Project 검색")} />
            </label>
            {visibleTargetCandidates.length > 0 && <div className="assistant-target-options">
              {visibleTargetCandidates.map((target) => <button key={target.id} onKeyDown={closeReferencesOnEscape} onClick={() => chooseTarget(target)}><span>{kindLabel(target.kind)}</span>{target.title}</button>)}
            </div>}
          </div>}
          {conversationHistory.some((entry) => entry.role === "user") && guideQuestions.length > 0 && <div className="assistant-followups">{guideQuestions.map((question) => <button className="followup-message" onClick={() => chooseQuickReply(question)} key={question}>{question}</button>)}</div>}
          {!canWrite && <div className="assistant-readonly"><Eye size={14} /><span>{t("Viewer는 대화와 분석을 이용할 수 있지만 항목을 생성할 수 없습니다.")}</span></div>}
          <GuideDraft active={Boolean(usageScope)} ready={draftHydrated && !saving} onUse={(value) => setMessage((current) => current.trim() ? `${current}\n\n${value}` : value)} />
          <div className="chat-input"><label htmlFor="assistant-message">{t("메시지")}</label><div className="chat-composer"><textarea id="assistant-message" value={message} onChange={(event) => setMessage(event.target.value)} onKeyDown={(event) => { if ((event.ctrlKey || event.metaKey) && event.key === "Enter") void organizeMessage(); }} rows={4} placeholder={mode === "task" ? t("해야 할 일을 편하게 설명해 주세요") : mode === "project" ? t("만들 Project의 결과와 범위를 설명해 주세요") : mode === "routine" ? t("언제 무엇을 반복할지 설명해 주세요") : t("지금 이루고 싶은 목표나 막힌 일을 편하게 적어 주세요")} /><button type="button" className="chat-send-button" onClick={() => void organizeMessage()} disabled={saving || !message.trim()} aria-label={saving ? t("답변 생성 중") : t("메시지 보내기")}>{saving ? <LoaderCircle className="spin" size={15} /> : <Send size={15} />}<span>{saving ? t("답변 중") : t("보내기")}</span></button></div></div>
          <div className="chat-actions">
            {hasDraft && canWrite && <button className="welcome-primary" onClick={() => void save()} disabled={saving || !canApplyDraft}>{saving ? t("생성 중") : saveLabel}<ChevronRight size={14} /></button>}
          </div>
          {hasDraft && assistantFlow && okrTarget && (okrTarget.kind === "key_result" || okrTarget.kind === "initiative") && <button className="assistant-skip" onClick={skipOptionalStep}>{t("지금은 건너뛰기")}</button>}
        </div>
        {mode !== "task" && hasOkrDraft(plan) && <OkrDraftTree
          plan={plan}
          target={okrTarget}
          onPatchObjective={patchObjective}
          onAddKeyResult={addKeyResult}
          onPatchKeyResult={patchKeyResult}
          onRemoveKeyResult={removeKeyResult}
          onAddInitiative={addInitiative}
          onPatchInitiative={patchInitiative}
          onRemoveInitiative={removeInitiative}
          onMoveInitiative={moveInitiative}
        />}
        {visibleFields.size > 0 && <div className="okr-setup-fields home-draft-fields">
          {mode === "project" && visibleFields.has("project") && <label><span>{t("Project")}</span><input value={plan.project} onChange={(event) => patch("project", event.target.value)} placeholder={t("결과와 범위가 분명한 첫 Project")} /></label>}
          {mode === "project" && visibleFields.has("project") && <label><span>{t("상위 Initiative")}</span><select value={projectTarget?.initiativeId ?? ""} onChange={(event) => setProjectTarget(projectTargets.find((entry) => entry.initiativeId === event.target.value) ?? null)}><option value="">{t("저장 전에 선택")}</option>{projectTargets.map((entry) => <option value={entry.initiativeId} key={entry.initiativeId}>{entry.cycleName} · {entry.initiativeTitle}</option>)}</select></label>}
          {mode === "project" && visibleFields.has("project") && members.length > 0 && <label><span>{t("Project 책임자")}</span><select value={projectDriMemberId} onChange={(event) => setProjectDriMemberId(event.target.value)}>{members.map((member) => <option value={member.id} key={member.id}>{member.displayName}</option>)}</select></label>}
          {(mode === "task" || mode === "project" || mode === "routine") && visibleFields.has("tasks") && <label className="wide"><span>{mode === "task" ? t("Task 초안") : plan.taskParent === "routine" || !plan.project.trim() && plan.routineTitle.trim() ? t("첫 Task · Routine 아래") : plan.project.trim() ? t("첫 Task · Project 아래") : t("첫 Task")}</span><textarea value={plan.tasks} onChange={(event) => patch("tasks", event.target.value)} rows={4} placeholder={t("한 줄에 하나씩 입력")} /></label>}
          {mode === "task" && visibleFields.has("tasks") && taskContainers.length > 0 && <label><span>{t("연결 대상 · 선택 사항")}</span><select value={taskContainer} onChange={(event) => setTaskContainer(event.target.value)}><option value="">{t("선택 안 함 — General에 저장")}</option>{taskContainers.some((entry) => entry.kind === "project") && <optgroup label={t("Project")}>{taskContainers.filter((entry) => entry.kind === "project").map((entry) => <option key={entry.id} value={`project:${entry.id}`}>{entry.title}</option>)}</optgroup>}{taskContainers.some((entry) => entry.kind === "routine") && <optgroup label={t("Routine")}>{taskContainers.filter((entry) => entry.kind === "routine").map((entry) => <option key={entry.id} value={`routine:${entry.id}`}>{entry.title}</option>)}</optgroup>}</select></label>}
          {mode === "task" && visibleFields.has("tasks") && members.length > 0 && <label><span>{t("담당자")}</span><select value={taskAssigneeMemberId} onChange={(event) => setTaskAssigneeMemberId(event.target.value)}><option value="">{t("미지정")}</option>{members.map((member) => <option value={member.id} key={member.id}>{member.displayName}</option>)}</select></label>}
          {mode === "task" && visibleFields.has("tasks") && taskContainers.length === 0 && <p className="task-container-empty task-container-general">{t("연결할 Project·Routine이 없어 General(기본)에 저장됩니다.")}</p>}
          {visibleFields.has("tasks") && plan.project.trim() && plan.routineTitle.trim() && <label><span>{t("Task 상위")}</span><select value={plan.taskParent || "project"} onChange={(event) => patch("taskParent", event.target.value)}><option value="project">{t("Project")}</option><option value="routine">{t("Routine")}</option></select></label>}
          {visibleFields.has("routineTitle") && <label><span>{t("Routine 이름")}</span><input value={plan.routineTitle} onChange={(event) => patch("routineTitle", event.target.value)} placeholder={t("반복해서 할 일의 이름")} /></label>}
          {visibleFields.has("routineTrigger") && <label><span>{t("Routine 트리거")}</span><input value={plan.routineTrigger} onChange={(event) => patch("routineTrigger", event.target.value)} placeholder={t("Routine이 시작되는 시점")} /></label>}
          {visibleFields.has("routinePlace") && <label><span>{t("어디서")}</span><input value={plan.routinePlace} onChange={(event) => patch("routinePlace", event.target.value)} placeholder={t("실행할 장소나 도구")} /></label>}
          {visibleFields.has("routineSteps") && <label className="wide"><span>{t("무엇을 어떻게")}</span><textarea value={plan.routineSteps} onChange={(event) => patch("routineSteps", event.target.value)} rows={3} placeholder={t("Routine 실행 방법")} /></label>}
          {mode === "routine" && visibleFields.has("routineTitle") && <label><span>{t("반복 주기")}</span><select value={plan.routineCadence} onChange={(event) => setPlan((current) => ({ ...current, routineCadence: event.target.value as RoutineCadence }))}><option value="daily">{t("매일")}</option><option value="weekly">{t("매주")}</option><option value="monthly">{t("매월")}</option></select></label>}
          {mode === "routine" && visibleFields.has("routineTitle") && members.length > 0 && <label><span>{t("담당자")}</span><select value={routineAssigneeMemberId} onChange={(event) => setRoutineAssigneeMemberId(event.target.value)}><option value="">{t("담당자 없음")}</option>{members.map((member) => <option value={member.id} key={member.id}>{member.displayName}</option>)}</select></label>}
          {mode === "project" && visibleFields.has("project") && projectTargets.length === 0 && <div className="task-container-empty"><span>{t("연결할 Initiative가 없습니다.")}</span><button type="button" onClick={onNavigateToOkr}>{t("먼저 Initiative 만들기")}</button></div>}
        </div>}
      </div>
    </section>
  );
}

function OkrDraftTree({ plan, target, onPatchObjective, onAddKeyResult, onPatchKeyResult, onRemoveKeyResult, onAddInitiative, onPatchInitiative, onRemoveInitiative, onMoveInitiative }: {
  plan: OnboardingPlan;
  target: OkrPlanTarget | null;
  onPatchObjective: (value: string) => void;
  onAddKeyResult: () => void;
  onPatchKeyResult: (clientId: string, value: string) => void;
  onRemoveKeyResult: (clientId: string) => void;
  onAddInitiative: (keyResultId?: string) => void;
  onPatchInitiative: (clientId: string, value: string) => void;
  onRemoveInitiative: (clientId: string) => void;
  onMoveInitiative: (clientId: string, targetKeyResultId: string) => void;
}) {
  const counts = countOkrDraft(plan);
  const editingTargetKeyResult = target?.kind === "key_result";
  return (
    <section className="okr-draft-tree" aria-label={t("OKR 트리 초안")}>
      <header>
        <div><Target size={15} /><b>{t("OKR 트리 초안")}</b></div>
        <span>{target ? t("기존 항목 아래 추가") : t("Objective 1개")} · {t("KR {kr}개 · Initiative {initiative}개", { kr: counts.keyResults, initiative: counts.initiatives })}</span>
      </header>
      {editingTargetKeyResult ? (
        <>
          <div className="okr-draft-root readonly"><span>{t("Key Result")}</span><b>{target.title}</b></div>
          <div className="okr-draft-target-initiatives">
            {plan.targetInitiatives.map((initiative, index) => (
              <div className="okr-draft-initiative-row" key={initiative.clientId}>
                <Zap size={13} />
                <label><span>{t("Initiative")}{index + 1}</span><textarea rows={2} value={initiative.title} onChange={(event) => onPatchInitiative(initiative.clientId, event.target.value)} placeholder={t("이 KR을 움직일 실행 방향")} /></label>
                <button type="button" className="icon-button" onClick={() => onRemoveInitiative(initiative.clientId)} aria-label={t("Initiative 제거")} title={t("Initiative 제거")}><Trash2 size={13} /></button>
              </div>
            ))}
            <button type="button" className="okr-draft-add" onClick={() => onAddInitiative()}><Plus size={13} />{t("Initiative 추가")}</button>
          </div>
        </>
      ) : (
        <>
          {target?.kind === "objective"
            ? <div className="okr-draft-root readonly"><span>{t("Objective")}</span><b>{target.title}</b></div>
            : <label className="okr-draft-root"><span>{t("Objective")}</span><textarea rows={2} value={plan.objectiveTitle} onChange={(event) => onPatchObjective(event.target.value)} placeholder={t("이번 주기에 이루고 싶은 변화")} /></label>}
          <div className="okr-draft-key-results">
            {plan.keyResults.map((keyResult, keyResultIndex) => (
              <section className="okr-draft-key-result" key={keyResult.clientId}>
                <div className="okr-draft-key-result-row">
                  <Hash size={13} />
                  <label><span>{t("Key Result")}{keyResultIndex + 1}</span><textarea rows={2} value={keyResult.title} onChange={(event) => onPatchKeyResult(keyResult.clientId, event.target.value)} placeholder={t("달성 여부를 확인할 측정 가능한 결과")} /></label>
                  <div>
                    <button type="button" className="icon-button" onClick={() => onAddInitiative(keyResult.clientId)} aria-label={t("{value1}번 KR에 Initiative 추가", { value1: messageValue(keyResultIndex + 1) })} title={t("Initiative 추가")}><Plus size={13} /></button>
                    <button type="button" className="icon-button" onClick={() => onRemoveKeyResult(keyResult.clientId)} aria-label={t("{value1}번 KR 제거", { value1: messageValue(keyResultIndex + 1) })} title={t("Key Result 제거")}><Trash2 size={13} /></button>
                  </div>
                </div>
                <div className="okr-draft-initiatives">
                  {keyResult.initiatives.map((initiative, initiativeIndex) => (
                    <div className="okr-draft-initiative-row" key={initiative.clientId}>
                      <Zap size={13} />
                      <label><span>{t("Initiative")}{initiativeIndex + 1}</span><textarea rows={2} value={initiative.title} onChange={(event) => onPatchInitiative(initiative.clientId, event.target.value)} placeholder={t("이 KR을 움직일 실행 방향")} /></label>
                      {plan.keyResults.length > 1 && <select value={keyResult.clientId} onChange={(event) => onMoveInitiative(initiative.clientId, event.target.value)} aria-label={t("{value1}의 Key Result", { value1: messageValue(initiative.title || t("Initiative")) })}>
                        {plan.keyResults.map((candidate, index) => <option value={candidate.clientId} key={candidate.clientId}>KR {index + 1}</option>)}
                      </select>}
                      <button type="button" className="icon-button" onClick={() => onRemoveInitiative(initiative.clientId)} aria-label={t("Initiative 제거")} title={t("Initiative 제거")}><Trash2 size={13} /></button>
                    </div>
                  ))}
                </div>
              </section>
            ))}
            <button type="button" className="okr-draft-add" onClick={onAddKeyResult}><Plus size={13} />{t("Key Result 추가")}</button>
          </div>
          {plan.unassignedInitiatives.length > 0 && <section className="okr-draft-unassigned">
            <header><AlertTriangle size={13} /><div><b>{t("KR 미지정 Initiative")}</b><span>{t("저장하려면 연결할 KR을 선택해 주세요.")}</span></div></header>
            {plan.unassignedInitiatives.map((initiative) => (
              <div className="okr-draft-initiative-row" key={initiative.clientId}>
                <Zap size={13} />
                <label><span>{t("Initiative")}</span><textarea rows={2} value={initiative.title} onChange={(event) => onPatchInitiative(initiative.clientId, event.target.value)} /></label>
                <select value="" onChange={(event) => event.target.value && onMoveInitiative(initiative.clientId, event.target.value)} aria-label={t("{value1}를 연결할 Key Result", { value1: messageValue(initiative.title || t("Initiative")) })}>
                  <option value="">{t("KR 선택")}</option>
                  {plan.keyResults.map((candidate, index) => <option value={candidate.clientId} key={candidate.clientId}>KR {index + 1}</option>)}
                </select>
                <button type="button" className="icon-button" onClick={() => onRemoveInitiative(initiative.clientId)} aria-label={t("미지정 Initiative 제거")} title={t("Initiative 제거")}><Trash2 size={13} /></button>
              </div>
            ))}
          </section>}
        </>
      )}
    </section>
  );
}

function hasOkrDraft(plan: OnboardingPlan) {
  return Boolean(plan.objectiveTitle.trim() || plan.keyResults.length || plan.targetInitiatives.length || plan.unassignedInitiatives.length);
}

function countOkrDraft(plan: OnboardingPlan) {
  return {
    keyResults: plan.keyResults.length,
    initiatives: plan.keyResults.reduce((total, entry) => total + entry.initiatives.length, 0) + plan.targetInitiatives.length + plan.unassignedInitiatives.length,
  };
}

function createDraftClientId(kind: "kr" | "initiative") {
  return `draft-${kind}-${crypto.randomUUID()}`;
}

function planStringFieldsWithValues(plan: OnboardingPlan) {
  const fields: StringPlanField[] = ["project", "tasks", "taskParent", "routineTitle", "routineTrigger", "routinePlace", "routineSteps"];
  return fields.filter((field) => plan[field].trim());
}

function buildAssistantWorkspaceContext(activeItems: OkriItem[], cycle: OkrCycle | null, focusedProject: OkriItem | null): AssistantWorkspaceContext {
  const cycleItems = cycle ? activeItems.filter((entry) => entry.cycleId === cycle.id) : [];
  const includedIds = new Set(cycleItems.map((entry) => entry.id));
  const linkedTasks = activeItems.filter((entry) => entry.kind === "task" && entry.parentId && includedIds.has(entry.parentId));
  const contextualItems = [...cycleItems, ...linkedTasks.filter((entry) => !includedIds.has(entry.id))];
  return {
    cycleId: cycle?.id ?? null,
    cycleName: cycle?.name ?? "",
    focusedItemId: focusedProject?.id ?? null,
    blockedTaskCount: contextualItems.filter((entry) => entry.kind === "task" && entry.status === "blocked").length,
    items: contextualItems.slice(0, 80).map((entry) => ({
      id: entry.id,
      parentId: entry.parentId,
      kind: entry.kind,
      title: entry.title,
      status: entry.status,
      progress: entry.progress,
      dri: entry.assignments.find((assignment) => assignment.role === "project_dri")?.displayName ?? "",
    })),
  };
}

function deriveAssistantTargeting(context: AssistantWorkspaceContext) {
  const candidates = context.items
    .filter((item) => item.kind === "objective" || item.kind === "key_result" || item.kind === "initiative" || item.kind === "project")
    .map((item) => ({ id: item.id, kind: item.kind as OkrPlanTarget["kind"], title: item.title }));
  const focused = candidates.find((item) => item.id === context.focusedItemId) ?? null;
  return { target: focused, candidates };
}

function assistantOpeningMessage() {
  return t("목표나 할 일을 편하게 이야기해 주세요. 기존 OKR과 업무를 참고해 함께 정리할게요.");
}

function targetPrompt(target: OkrPlanTarget) {
  if (target.kind === "objective") return t("{value1} Objective를 기준으로 이야기하겠습니다. 이 목표의 성공을 확인할 Key Result부터 정리할까요?", { value1: messageValue(target.title) });
  if (target.kind === "key_result") return t("{value1} Key Result를 기준으로 이야기하겠습니다. 이 결과를 움직일 Initiative를 정리할까요?", { value1: messageValue(target.title) });
  if (target.kind === "project") return t("{value1} Project를 기준으로 이야기하겠습니다. 진행 상황, 막힌 일, 다음 Task 중 무엇부터 정리할까요?", { value1: messageValue(target.title) });
  return t("{value1} Initiative를 기준으로 이야기하겠습니다. 이 실행 방향을 실제로 움직일 Project를 정리할까요?", { value1: messageValue(target.title) });
}

function aiLimitMessage(error: OrganizeError) {
  return aiUsageLimitMessage(error, t, getClientLocale());
}

function OkrFileManager({
  cycles,
  selectedCycle,
  itemCounts,
  deletingIds,
  slowDeletingId,
  onSelect,
  onSetDefault,
  onDelete,
  onCreate,
  onClose,
}: {
  cycles: OkrCycle[];
  selectedCycle: OkrCycle | null;
  itemCounts: Record<string, number>;
  deletingIds: Set<string>;
  slowDeletingId: string | null;
  onSelect: (id: string) => void;
  onSetDefault: (id: string) => void;
  onDelete: (id: string) => void;
  onCreate: () => void;
  onClose: () => void;
}) {
  return (
    <section className="okr-file-manager">
      <header>
        <div><b>{t("OKR 파일")}</b><span>{t("{count}개", { count: cycles.length })}</span></div>
        <div>
          <button type="button" onClick={onCreate}><Plus size={13} />{t("새로 만들기")}</button>
          <button className="icon-button" type="button" onClick={onClose} aria-label={t("목록 닫기")} title={t("목록 닫기")}><X size={15} /></button>
        </div>
      </header>
      <div className="okr-file-list" aria-label={t("OKR 파일 목록")}>
        {cycles.map((cycle, index) => (
          <OkrFileRow
            key={`${cycle.id}-${cycle.name}-${cycle.department}`}
            cycle={cycle}
            selected={cycle.id === selectedCycle?.id}
            latest={index === 0}
            itemCount={itemCounts[cycle.id] ?? 0}
            canDelete={cycles.length > 1}
            deleting={deletingIds.has(cycle.id)}
            slowDeleting={slowDeletingId === cycle.id}
            onSelect={onSelect}
            onSetDefault={onSetDefault}
            onDelete={onDelete}
          />
        ))}
        {!cycles.length && <EmptyState icon={Archive} title={t("OKR 파일이 없습니다")} />}
      </div>
    </section>
  );
}

function OkrFileRow({
  cycle,
  selected,
  latest,
  itemCount,
  canDelete,
  deleting,
  slowDeleting,
  onSelect,
  onSetDefault,
  onDelete,
}: {
  cycle: OkrCycle;
  selected: boolean;
  latest: boolean;
  itemCount: number;
  canDelete: boolean;
  deleting: boolean;
  slowDeleting: boolean;
  onSelect: (id: string) => void;
  onSetDefault: (id: string) => void;
  onDelete: (id: string) => void;
}) {
  return (
    <article className={`okr-file-row ${selected ? "active" : ""}`}>
      <button className="okr-file-open" type="button" onClick={() => onSelect(cycle.id)} aria-label={t("{value1} 열기", { value1: messageValue(cycle.name) })}><Archive size={15} /><span><b>{cycle.name}</b><small>v{cycle.version} · {cycle.startDate} - {cycle.endDate} · {cycle.department || t("부서 미지정")} · {t("{count}개 항목", { count: itemCount })}{slowDeleting ? ` · ${t("삭제 중")}` : ""}</small></span></button>
      <div className="okr-file-row-actions">
        {selected && <em>{t("열림")}</em>}
        {cycle.status === "active" ? <em>{t("기본")}</em> : <button type="button" onClick={() => onSetDefault(cycle.id)}>{t("기본")}</button>}
        {latest && <em>{t("최신")}</em>}
        <button type="button" className={deleting ? "is-loading" : ""} onClick={() => onDelete(cycle.id)} disabled={!canDelete || deleting} aria-label={t("{value1} 삭제", { value1: messageValue(cycle.name) })} title={deleting ? t("삭제 중") : canDelete ? t("삭제") : t("마지막 파일은 삭제할 수 없습니다")}>{deleting ? <LoaderCircle size={12} /> : <Trash2 size={12} />}</button>
      </div>
    </article>
  );
}

function DeleteSelectCheckbox({ item, selected, onToggle }: { item: Pick<OkriItem, "id" | "kind" | "title">; selected: boolean; onToggle: (id: string) => void }) {
  return (
    <label className="delete-select" title={t("{value1} 삭제 선택", { value1: messageValue(item.title) })}>
      <input type="checkbox" checked={selected} onChange={() => onToggle(item.id)} aria-label={t("{value1} {value2} 삭제 선택", { value1: messageValue(item.kind === "project" ? t("Project") : t("Task")), value2: messageValue(item.title) })} />
      <span><Check size={11} /></span>
    </label>
  );
}

function BoardView({ items, onOpenItem, canDeleteItem, selectedItemIds, onToggleSelect, selectionMode }: { items: OkriItem[]; onOpenItem: (item: OkriItem) => void; canDeleteItem: (item: OkriItem) => boolean; selectedItemIds: Set<string>; onToggleSelect: (id: string) => void; selectionMode: boolean }) {
  const columns: { status: ItemStatus; label: string }[] = [
    { status: "backlog", label: "백로그" },
    { status: "todo", label: "할 일" },
    { status: "policy_discussion", label: "정책 논의" },
    { status: "in_progress", label: "진행 중" },
    { status: "developing", label: "개발 중" },
    { status: "development_done", label: "개발 완료" },
    { status: "blocked", label: "막힘" },
  ];
  return <div className="board">{columns.map((column) => { const rows = items.filter((entry) => entry.status === column.status); return <section className="board-column" key={column.status}><header><span className={`status-dot status-${column.status}`} /><b>{column.label}</b><em>{rows.length}</em></header><div>{rows.map((entry) => <article className={`board-selectable-item ${selectionMode ? "selection-mode" : ""}`} key={entry.id}>{selectionMode && canDeleteItem(entry) && <DeleteSelectCheckbox item={entry} selected={selectedItemIds.has(entry.id)} onToggle={onToggleSelect} />}<button className="board-item" onClick={() => onOpenItem(entry)}><b className={entry.kind === "project" ? "project-item-title" : undefined}>{entry.title}</b><span><CalendarDays size={13} />{dueLabel(entry.dueDate)}</span></button></article>)}{!rows.length && <span className="empty-column">{t("작업 없음")}</span>}</div></section>; })}</div>;
}

function TaskListView({ items, allItems, routines, onOpenTask, onPatch, canDeleteItem, selectedItemIds, onToggleSelect, onSelectItems, onClearItems, onTrashSelected, trashing }: { items: OkriItem[]; allItems: OkriItem[]; routines: Routine[]; onOpenTask: (id: string) => void; onPatch: (id: string, patch: Partial<OkriItem>) => Promise<unknown>; canDeleteItem: (item: OkriItem) => boolean; selectedItemIds: Set<string>; onToggleSelect: (id: string) => void; onSelectItems: (ids: string[]) => void; onClearItems: (ids: string[]) => void; onTrashSelected: () => void; trashing: boolean }) {
  const [selectionMode, setSelectionMode] = useState(false);
  const byId = new Map(allItems.map((entry) => [entry.id, entry]));
  const routineIds = new Set(routines.map((entry) => entry.id));
  const deletableItems = items.filter(canDeleteItem);
  const taskIds = deletableItems.map((entry) => entry.id);
  const selectedTaskCount = taskIds.filter((id) => selectedItemIds.has(id)).length;
  const allSelected = deletableItems.length > 0 && selectedTaskCount === deletableItems.length;
  const orphanedIds = deletableItems.filter((entry) => entry.parentId
    ? byId.get(entry.parentId)?.kind !== "project"
    : entry.routineId ? !routineIds.has(entry.routineId) : true).map((entry) => entry.id);
  if (!items.length) return <EmptyState icon={Inbox} title={t("Task가 없습니다")} />;
  return (
    <section className="task-list" aria-label={t("Task 목록")}>
      <div className="task-list-summary"><span>{t("{kind} · {count}", { kind: t("Task"), count: items.length })}</span>{deletableItems.length > 0 && <button aria-pressed={selectionMode} onClick={() => { if (selectionMode) onClearItems(taskIds); setSelectionMode((current) => !current); }}>{selectionMode ? <X size={13} /> : <ListChecks size={13} />}{selectionMode ? t("선택 종료") : t("선택")}</button>}</div>
      {selectionMode && deletableItems.length > 0 && <div className="task-selection-bar">
        <label><input type="checkbox" checked={allSelected} onChange={() => allSelected ? onClearItems(taskIds) : onSelectItems(taskIds)} /><span>{allSelected ? t("전체 선택 해제") : t("전체 선택")}</span></label>
        <b>{selectedTaskCount ? t("{value1}개 선택", { value1: messageValue(selectedTaskCount) }) : t("삭제 가능 {value1}개", { value1: messageValue(deletableItems.length) })}</b>
        {orphanedIds.length > 0 && <button className="orphan-task-select" onClick={() => onSelectItems(orphanedIds)}><AlertTriangle size={13} />{t("연결 끊긴 Task")}{t("{count}개 선택", { count: orphanedIds.length })}</button>}
        <button className="task-selection-delete" disabled={!selectedTaskCount || trashing} onClick={onTrashSelected}><Trash2 size={13} />{trashing ? t("이동 중") : t("선택 삭제")}</button>
      </div>}
      {items.map((entry) => {
        const project = entry.parentId ? byId.get(entry.parentId) : undefined;
        const routine = entry.routineId ? routines.find((row) => row.id === entry.routineId) : undefined;
        const relation = routine?.systemKey === "general" ? "General 수집함" : routine ? `Routine · ${routine.title}` : project?.kind === "project" ? `Project · ${project.title}` : "연결 끊김";
        const assignee = assignmentLabel(entry, "task_assignee");
        return (
          <article className={`task-list-row ${selectionMode && canDeleteItem(entry) ? "deletion-selectable" : ""} ${isCompletedStatus(entry.status) ? "completed" : ""}`} key={entry.id}>
            {selectionMode && canDeleteItem(entry) && <DeleteSelectCheckbox item={entry} selected={selectedItemIds.has(entry.id)} onToggle={onToggleSelect} />}
            <button className={`task-list-check ${isCompletedStatus(entry.status) ? "checked" : ""}`} aria-pressed={isCompletedStatus(entry.status)} onClick={() => void onPatch(entry.id, taskCompletionPatch(entry.status))} aria-label={`${entry.title} ${isCompletedStatus(entry.status) ? t("완료 취소") : t("완료")}`}><Check size={13} /></button>
            <button className="task-list-open" onClick={() => onOpenTask(entry.id)}>
              <b>{entry.title}</b>
              <span className="task-list-inline-meta">{assignee}<em>·</em>{relation}{entry.dueDate && <><em>·</em>{dueLabel(entry.dueDate)}</>}</span>
            </button>
            <button className="task-list-chevron" onClick={() => onOpenTask(entry.id)} aria-label={t("{value1} 상세 열기", { value1: messageValue(entry.title) })}><ChevronRight size={15} /></button>
          </article>
        );
      })}
    </section>
  );
}

function AsyncState({ icon: Icon, title, detail, actionLabel, onAction, loading = false }: { icon: LucideIcon; title: string; detail?: string; actionLabel?: string; onAction?: () => void; loading?: boolean }) {
  return (
    <section className="async-state" role={loading ? "status" : "alert"} aria-live="polite">
      <span className={loading ? "spinning" : ""}><Icon size={18} /></span>
      <div><b>{title}</b>{detail && <p>{detail}</p>}</div>
      {actionLabel && onAction && <button type="button" onClick={onAction}><RotateCcw size={14} />{actionLabel}</button>}
    </section>
  );
}

function TrashView({ workspaceId, onNotice, canDeleteRecords, canRestore }: { workspaceId: string; onNotice: (message: string) => void; canDeleteRecords: boolean; canRestore: boolean }) {
  const confirmAction = useAppConfirm();
  const initialCache = trashMemoryCache.get(workspaceId) ?? null;
  const [records, setRecords] = useState<TrashRecord[] | null>(() => initialCache?.records ?? null);
  const [trashedItems, setTrashedItems] = useState<TrashedItem[] | null>(() => initialCache?.items ?? null);
  const [initiativeOptions, setInitiativeOptions] = useState<TrashInitiativeOption[]>(() => initialCache?.initiativeOptions ?? []);
  const [restoreParents, setRestoreParents] = useState<Record<string, string>>({});
  const [loadError, setLoadError] = useState(false);
  const [loadAttempt, setLoadAttempt] = useState(0);
  useEffect(() => {
    let active = true;
    const cached = trashMemoryCache.get(workspaceId) ?? null;
    const cacheKey = `trash:${workspaceId}`;
    if (cached && viewCacheIsFresh(cacheKey)) return () => { active = false; };
    Promise.all([fetch("/api/item-trash"), fetch("/api/trash")])
      .then(async ([itemResponse, recordResponse]) => {
        if (!itemResponse.ok || !recordResponse.ok) throw new Error("trash-load-failed");
        const itemData = await itemResponse.json() as { items: TrashedItem[]; initiativeOptions: TrashInitiativeOption[] };
        const recordData = await recordResponse.json() as { trash: TrashRecord[] };
        return { items: itemData.items, records: recordData.trash, initiativeOptions: itemData.initiativeOptions ?? [] };
      })
      .then((data) => {
        if (!active) return;
        trashMemoryCache.set(workspaceId, { records: data.records, items: data.items, initiativeOptions: data.initiativeOptions });
        markViewCacheFresh(cacheKey);
        setLoadError(false);
        setTrashedItems(data.items);
        setRecords(data.records);
        setInitiativeOptions(data.initiativeOptions);
      })
      .catch(() => { if (active && !cached) setLoadError(true); });
    return () => { active = false; };
  }, [loadAttempt, workspaceId]);

  useEffect(() => {
    if (records !== null && trashedItems !== null) {
      trashMemoryCache.set(workspaceId, { records, items: trashedItems, initiativeOptions });
      markViewCacheFresh(`trash:${workspaceId}`);
    }
  }, [initiativeOptions, records, trashedItems, workspaceId]);

  async function permanentlyDeleteRecord(record: TrashRecord) {
    if (!await confirmAction({ title: t("휴지통 기록 영구 삭제"), message: t("'{value1}' 기록은 복구할 수 없게 됩니다.", { value1: messageValue(record.title) }), confirmationText: t("영구 삭제"), confirmLabel: t("영구 삭제"), danger: true })) return;
    const response = await fetch(`/api/trash?id=${encodeURIComponent(record.id)}`, { method: "DELETE" });
    if (!response.ok) {
      onNotice(t("휴지통 기록을 삭제하지 못했습니다."));
      return;
    }
    setRecords((current) => current?.filter((entry) => entry.id !== record.id) ?? []);
    onNotice(t("휴지통 기록을 영구 삭제했습니다."));
  }

  async function restoreRecord(record: TrashRecord) {
    const response = await fetch("/api/trash", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: record.id, action: "restore" }),
    });
    if (!response.ok) {
      const data = await response.json().catch(() => ({})) as { error?: string };
      onNotice(apiError(data, "휴지통 기록을 복구하지 못했습니다."));
      return;
    }
    window.location.reload();
  }

  async function restoreItem(entry: TrashedItem) {
    const restoreParentId = restoreParents[entry.id];
    if (entry.kind === "project" && entry.restoreParentRequired && !restoreParentId) {
      onNotice(t("복구할 Initiative를 먼저 선택해 주세요."));
      return;
    }
    const response = await fetch("/api/item-trash", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ itemIds: [entry.id], action: "restore", projectParentIds: restoreParentId ? { [entry.id]: restoreParentId } : {} }),
    });
    if (!response.ok) {
      const data = await response.json().catch(() => ({})) as { error?: string };
      onNotice(apiError(data, "항목을 복구하지 못했습니다."));
      return;
    }
    clearCachedBootstrap();
    window.location.reload();
  }

  async function permanentlyDeleteItem(entry: TrashedItem) {
    const taskCopy = entry.kind === "project" ? t("와 하위 Task {value1}개", { value1: messageValue(entry.trashedTaskCount) }) : "";
    if (!await confirmAction({ title: t("항목 영구 삭제"), message: t("'{value1}'{value2}를 영구 삭제합니다.\n체크리스트, 담당자, 속성값, 문서와 활동 기록도 삭제되며 복구할 수 없습니다.", { value1: messageValue(entry.title), value2: messageValue(taskCopy) }), confirmationText: t("영구 삭제"), confirmLabel: t("영구 삭제"), danger: true })) return;
    const confirmationText = "영구 삭제";
    const response = await fetch("/api/item-trash", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ itemIds: [entry.id], confirmationText }),
    });
    if (!response.ok) {
      const data = await response.json().catch(() => ({})) as { error?: string };
      onNotice(apiError(data, "항목을 영구 삭제하지 못했습니다."));
      return;
    }
    setTrashedItems((current) => current?.filter((item) => item.id !== entry.id) ?? []);
    onNotice(t("{value1}을 영구 삭제했습니다.", { value1: messageValue(entry.kind === "project" ? "Project 묶음" : "Task") }));
  }

  if (loadError) return <AsyncState icon={AlertTriangle} title={t("휴지통을 불러오지 못했습니다")} detail={t("삭제 항목과 클린업 기록은 그대로 보존되어 있습니다.")} actionLabel={t("다시 시도")} onAction={() => { setRecords(null); setTrashedItems(null); setLoadError(false); setLoadAttempt((attempt) => attempt + 1); }} />;
  if (records === null || trashedItems === null) return <AsyncState icon={LoaderCircle} title={t("휴지통을 불러오는 중입니다")} loading />;
  if (!records.length && !trashedItems.length) return <EmptyState icon={Trash2} title={t("휴지통이 비어 있습니다")} />;

  return (
    <div className="trash-sections">
      {trashedItems.length > 0 && <section className="trash-list" aria-label={t("삭제한 Project와 Task")}>
        <header className="trash-section-title"><div><b>Project·Task</b><span>{trashedItems.length}</span></div><p>{t("Project는 함께 삭제한 하위 Task까지 한 묶음으로 복구하거나 영구 삭제합니다.")}</p></header>
        {trashedItems.map((entry) => (
          <article className="trash-record" key={entry.id}>
            <span className="trash-icon"><Trash2 size={15} /></span>
            <div>
              <h3>{entry.title}</h3>
              <p>{entry.kind === "project" ? t("Project · 하위 Task {value1}개", { value1: messageValue(entry.trashedTaskCount) }) : t("독립 삭제한 Task")}</p>
              <small>{entry.archivedAt ? formatDateTime(entry.archivedAt) : t("삭제됨")}</small>
              {canRestore && entry.restoreParentRequired && <label className="trash-restore-parent"><span>{t("복구할 Initiative")}</span><select value={restoreParents[entry.id] ?? ""} onChange={(event) => setRestoreParents((current) => ({ ...current, [entry.id]: event.target.value }))}><option value="">{t("Initiative 선택")}</option>{initiativeOptions.map((initiative) => <option value={initiative.id} key={initiative.id}>{initiative.title}</option>)}</select></label>}
            </div>
            {(canRestore || entry.canDelete) && <div className="trash-actions">{canRestore && <button disabled={entry.restoreParentRequired && !restoreParents[entry.id]} onClick={() => void restoreItem(entry)}><RotateCcw size={13} />{t("복구")}</button>}{entry.canDelete && <button className="danger" onClick={() => void permanentlyDeleteItem(entry)}><Trash2 size={13} />{t("영구 삭제")}</button>}</div>}
          </article>
        ))}
      </section>}
      {records.length > 0 && <section className="trash-list" aria-label={t("전체 OKR 클린업 기록")}>
        <header className="trash-section-title"><div><b>{t("전체 OKR 클린업 기록")}</b><span>{records.length}</span></div><p>{t("이전에 전체 정리로 보관한 백업입니다.")}</p></header>
        {records.map((record) => (
          <article className="trash-record" key={record.id}>
            <span className="trash-icon"><Archive size={15} /></span>
            <div>
              <h3>{record.title}</h3>
              <p>{trashSummary(record)}</p>
              <small>{formatDateTime(record.archivedAt)}</small>
            </div>
            {canDeleteRecords && <div className="trash-actions"><button onClick={() => void restoreRecord(record)}><RotateCcw size={13} />{t("복구")}</button><button className="danger" onClick={() => void permanentlyDeleteRecord(record)}><Trash2 size={13} />{t("영구 삭제")}</button></div>}
          </article>
        ))}
      </section>}
    </div>
  );
}

function ReviewView({ items, cadence, completed, blocked, averageProgress, onOpenTask, onOpenProject }: { items: OkriItem[]; cadence: Cadence; completed: number; blocked: number; averageProgress: number; onOpenTask: (id: string) => void; onOpenProject: (id: string) => void }) {
  return <section className="review-content"><div className="metrics-row"><div><span>{t("완료")}</span><strong>{completed}<small> / {items.length}</small></strong></div><div><span>{t("평균 진행")}</span><strong>{averageProgress}<small>%</small></strong></div><div><span>{t("막힘")}</span><strong>{blocked}</strong></div></div><div className="review-progress"><div><b>{cadenceLabels[cadence]} {t("측정 항목 진행률")}</b><span>{averageProgress}%</span></div><span><i style={{ width: `${averageProgress}%` }} /></span></div><div className="review-list"><span>{t("검토할 항목")}</span>{items.slice(0, 7).map((entry) => { const tracksProgress = entry.kind !== "objective" && entry.kind !== "initiative"; return entry.kind === "task" || entry.kind === "project" ? <button key={entry.id} onClick={() => entry.kind === "task" ? onOpenTask(entry.id) : onOpenProject(entry.id)}><span className={`status-dot status-${entry.status}`} /><b>{entry.title}</b>{tracksProgress && <em>{entry.progress}%</em>}<ChevronRight size={14} /></button> : <div key={entry.id}><span className={`status-dot status-${entry.status}`} /><b>{entry.title}</b>{tracksProgress && <em>{entry.progress}%</em>}</div>; })}{!items.length && <p className="my-work-empty">{t("이 기간에 검토할 항목이 없습니다.")}</p>}</div></section>;
}

function ProjectPropertyManager({ workspaceId, properties, teamMembers, readOnly, onChanged, onNotice, scope = "project" }: { scope?: "project" | "routine"; workspaceId: string; properties: PropertyDefinition[]; teamMembers: TeamMember[]; readOnly: boolean; onChanged: (properties: PropertyDefinition[]) => void; onNotice: (message: string) => void }) {
  const confirmAction = useAppConfirm();
  const targetName = scope === "routine" ? "Routine" : "Project";
  const endpoint = scope === "routine" ? "/api/routine-properties" : "/api/properties";
  const cacheKey = `${scope}-properties:${workspaceId}`;
  const initialCatalog = propertyCatalogMemoryCache.get(cacheKey) ?? properties;
  const [catalog, setCatalog] = useState<PropertyDefinition[]>(initialCatalog);
  const [selectedId, setSelectedId] = useState<string | null>(initialCatalog.find((property) => property.active)?.id ?? null);
  const [creatingNew, setCreatingNew] = useState(false);
  const [showRemoved, setShowRemoved] = useState(false);
  const [name, setName] = useState("");
  const [type, setType] = useState<PropertyType>("text");
  const [options, setOptions] = useState("");
  const [defaultValue, setDefaultValue] = useState<PropertyValue>(null);
  const [saving, setSaving] = useState(false);
  const onChangedRef = useRef(onChanged);
  const onNoticeRef = useRef(onNotice);
  const visibleCatalog = catalog.filter((property) => showRemoved ? !property.active : property.active);
  const selected = visibleCatalog.find((property) => property.id === selectedId) ?? visibleCatalog[0] ?? null;

  useEffect(() => {
    onChangedRef.current = onChanged;
    onNoticeRef.current = onNotice;
  }, [onChanged, onNotice]);

  useEffect(() => {
    let active = true;
    if (propertyCatalogMemoryCache.has(cacheKey) && viewCacheIsFresh(cacheKey)) return () => { active = false; };
    void fetch(`${endpoint}?includeInactive=true`)
      .then(async (response) => response.ok ? response.json() as Promise<{ properties: PropertyDefinition[] }> : Promise.reject())
      .then((data) => {
        if (!active) return;
        propertyCatalogMemoryCache.set(cacheKey, data.properties);
        markViewCacheFresh(cacheKey);
        setCatalog(data.properties);
        onChangedRef.current(data.properties);
        setSelectedId((current) => current ?? data.properties.find((property) => property.active)?.id ?? null);
      })
      .catch(() => onNoticeRef.current(t("속성 목록을 새로 불러오지 못했습니다.")));
    return () => { active = false; };
  }, [cacheKey, endpoint]);

  function applyCatalog(next: PropertyDefinition[]) {
    const sorted = [...next].sort((left, right) => left.sortOrder - right.sortOrder);
    propertyCatalogMemoryCache.set(cacheKey, sorted);
    markViewCacheFresh(cacheKey);
    setCatalog(sorted);
    onChanged(sorted);
  }

  async function create(event: FormEvent) {
    event.preventDefault();
    if (!name.trim() || saving) return;
    setSaving(true);
    const response = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, type, options: options.split(",").map((entry) => entry.trim()).filter(Boolean), defaultValue }),
    });
    setSaving(false);
    if (!response.ok) { onNotice(t("속성을 추가하지 못했습니다.")); return; }
    const data = await response.json() as { property: PropertyDefinition };
    const created = { ...data.property, valueCount: data.property.valueCount ?? 0 };
    applyCatalog([...catalog, created]);
    setSelectedId(created.id);
    setCreatingNew(false);
    setName("");
    setOptions("");
    setDefaultValue(null);
    setShowRemoved(false);
    onNotice(t("모든 {value1}에 새 속성을 추가했습니다.", { value1: messageValue(targetName) }));
  }

  async function deactivate(property: PropertyDefinition) {
    const detail = property.valueCount > 0 ? t("\n{value1}개 {value2}의 값은 보존되며 화면에서만 숨겨집니다.", { value1: messageValue(property.valueCount), value2: messageValue(targetName) }) : "";
    if (!await confirmAction({ title: t("{value1} 속성 제거", { value1: messageValue(targetName) }), message: t("'{value1}' 속성을 화면에서 제거합니다.{value2}", { value1: messageValue(systemPropertyLabel(property, t)), value2: messageValue(detail) }), confirmLabel: t("속성 제거"), danger: true })) return;
    const response = await fetch(`${endpoint}?id=${encodeURIComponent(property.id)}`, { method: "DELETE" });
    if (!response.ok) { onNotice(t("속성을 삭제하지 못했습니다.")); return; }
    applyCatalog(catalog.map((entry) => entry.id === property.id ? { ...entry, active: false } : entry));
    onNotice(t("속성을 제거했습니다. 기존 값은 보존됩니다."));
  }

  async function saveProperty(property: PropertyDefinition, draft: PropertyDefinition) {
    setSaving(true);
    if (draft.type !== property.type || draft.options.join("\u0000") !== property.options.join("\u0000")) {
      const previewResponse = await fetch(endpoint, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id: property.id, type: draft.type, options: draft.options, preview: true }) });
      const preview = await previewResponse.json() as { analysis?: { convertibleCount: number; incompatibleCount: number } };
      if (!previewResponse.ok || !preview.analysis) { setSaving(false); onNotice(t("속성 유형 변경을 확인하지 못했습니다.")); return; }
      if (!await confirmAction({ title: t("속성 유형 변경"), message: t("변환 가능 {value1}개 · 보존할 기존 값 {value2}개", { value1: messageValue(preview.analysis.convertibleCount), value2: messageValue(preview.analysis.incompatibleCount) }), confirmLabel: t("유형 변경") })) { setSaving(false); return; }
    }
    const response = await fetch(endpoint, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id: property.id, name: draft.name, type: draft.type, options: draft.options, defaultValue: draft.defaultValue, sortOrder: draft.sortOrder, active: draft.active }) });
    setSaving(false);
    const data = await response.json() as { property?: PropertyDefinition; error?: string };
    if (!response.ok || !data.property) { onNotice(apiError(data, "속성을 저장하지 못했습니다.")); return; }
    applyCatalog(catalog.map((entry) => entry.id === property.id ? { ...data.property!, valueCount: property.valueCount } : entry));
    onNotice(t("속성 설정을 저장했습니다."));
  }

  async function restore(property: PropertyDefinition) {
    const response = await fetch(endpoint, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id: property.id, active: true }) });
    const data = await response.json() as { property?: PropertyDefinition };
    if (!response.ok || !data.property) { onNotice(t("속성을 복원하지 못했습니다.")); return; }
    applyCatalog(catalog.map((entry) => entry.id === property.id ? { ...data.property!, valueCount: property.valueCount } : entry));
    onNotice(t("속성과 기존 값을 복원했습니다."));
  }

  async function move(property: PropertyDefinition, direction: -1 | 1) {
    const ordered = [...visibleCatalog].sort((left, right) => left.sortOrder - right.sortOrder);
    const index = ordered.findIndex((entry) => entry.id === property.id);
    const target = ordered[index + direction];
    if (!target) return;
    const [firstResponse, secondResponse] = await Promise.all([
      fetch(endpoint, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id: property.id, sortOrder: target.sortOrder }) }),
      fetch(endpoint, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id: target.id, sortOrder: property.sortOrder }) }),
    ]);
    if (!firstResponse.ok || !secondResponse.ok) { onNotice(t("속성 순서를 바꾸지 못했습니다.")); return; }
    applyCatalog(catalog.map((entry) => entry.id === property.id ? { ...entry, sortOrder: target.sortOrder } : entry.id === target.id ? { ...entry, sortOrder: property.sortOrder } : entry));
  }

  return <section className="project-property-manager"><header><div><h2>{targetName} {t("속성")}</h2><p>{t("기본 속성과 커스텀 속성의 이름, 유형, 기본값과 순서를 관리합니다.")}</p></div><button disabled={readOnly} onClick={() => { setCreatingNew(true); setSelectedId(null); }}><Plus size={13} />{t("새 속성")}</button></header><div className="project-property-layout"><div className="project-property-catalog"><button type="button" className="property-removed-toggle secondary" aria-pressed={showRemoved} onClick={() => { setShowRemoved((value) => !value); setSelectedId(null); setCreatingNew(false); }}>{showRemoved ? t("사용 중인 속성 보기") : t("제거한 속성 ({value1})", { value1: messageValue(catalog.filter((property) => !property.active).length) })}</button>{!visibleCatalog.length && <p className="my-work-empty">{showRemoved ? t("제거한 속성이 없습니다.") : t("사용 중인 속성이 없습니다. 새 속성을 추가해 주세요.")}</p>}{visibleCatalog.map((property) => <article className={`project-property-item ${selected?.id === property.id ? "selected" : ""} ${property.active ? "" : "inactive"}`} key={property.id}><button type="button" className="project-property-select" onClick={() => { setSelectedId(property.id); setCreatingNew(false); }}><span className="property-type-icon">{property.type === "number" ? <Hash size={14} /> : property.type === "member" || property.type === "members" ? <Users size={14} /> : <TextCursorInput size={14} />}</span><div><b>{systemPropertyLabel(property, t)}{property.systemKey && <em>{t("기본")}</em>}</b><small>{propertyTypeLabel(property.type)} · {t("값 {count}개", { count: property.valueCount })}{!property.active && ` · ${t("제거됨")}`}</small></div></button><div className="property-order-actions"><button className="icon-button rotate-up" disabled={readOnly} onClick={() => void move(property, -1)} aria-label={t("{value1} 위로", { value1: messageValue(systemPropertyLabel(property, t)) })} title={t("위로")}><ChevronDown size={13} /></button><button className="icon-button" disabled={readOnly} onClick={() => void move(property, 1)} aria-label={t("{value1} 아래로", { value1: messageValue(systemPropertyLabel(property, t)) })} title={t("아래로")}><ChevronDown size={13} /></button></div></article>)}</div><div className="project-property-editor">{creatingNew ? <form className="project-property-create" onSubmit={create}><h3>{t("새 속성")}</h3><label><span>{t("이름")}</span><input disabled={readOnly} value={name} onChange={(event) => setName(event.target.value)} placeholder={t("예: 리스크, 예산, 출시일")} /></label><label><span>{t("유형")}</span><select disabled={readOnly} value={type} onChange={(event) => { setType(event.target.value as PropertyType); setDefaultValue(null); }}>{(["text", "number", "select", "date", "checkbox", "member", "members"] as PropertyType[]).map((entry) => <option value={entry} key={entry}>{propertyTypeLabel(entry)}</option>)}</select></label>{type === "select" && <label><span>{t("선택 옵션")}</span><input value={options} onChange={(event) => setOptions(event.target.value)} placeholder={t("쉼표로 구분")} /></label>}<PropertyDefaultInput type={type} options={options.split(",").map((entry) => entry.trim()).filter(Boolean)} value={defaultValue} members={teamMembers} disabled={readOnly} onChange={setDefaultValue} /><button className="primary-action" disabled={readOnly || !name.trim() || saving}><Plus size={14} />{saving ? t("추가 중") : t("속성 추가")}</button></form> : selected ? <PropertyDefinitionEditor key={`${selected.id}:${selected.name}:${selected.type}:${selected.active}:${String(selected.defaultValue)}`} property={selected} members={teamMembers} readOnly={readOnly} saving={saving} onSave={(draft) => void saveProperty(selected, draft)} onDeactivate={() => void deactivate(selected)} onRestore={() => void restore(selected)} /> : <EmptyState icon={Settings2} title={t("편집할 속성을 선택하세요")} />}</div></div></section>;
}

function PropertyDefinitionEditor({ property, members, readOnly, saving, onSave, onDeactivate, onRestore }: { property: PropertyDefinition; members: TeamMember[]; readOnly: boolean; saving: boolean; onSave: (property: PropertyDefinition) => void; onDeactivate: () => void; onRestore: () => void }) {
  const [draft, setDraft] = useState(property);
  return <form className="project-property-create" onSubmit={(event) => { event.preventDefault(); onSave(draft); }}><h3>{property.systemKey ? t("기본 속성 편집") : t("속성 편집")}</h3><label><span>{t("이름")}</span><input disabled={readOnly} value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value })} /></label><label><span>{t("유형")}</span><select disabled={readOnly} value={draft.type} onChange={(event) => setDraft({ ...draft, type: event.target.value as PropertyType, defaultValue: null })}>{(["text", "number", "select", "date", "checkbox", "member", "members"] as PropertyType[]).map((entry) => <option value={entry} key={entry}>{propertyTypeLabel(entry)}</option>)}</select></label>{draft.type === "select" && <label><span>{t("선택 옵션")}</span><input disabled={readOnly} value={draft.options.join(", ")} onChange={(event) => setDraft({ ...draft, options: event.target.value.split(",").map((entry) => entry.trim()).filter(Boolean) })} /></label>}<PropertyDefaultInput type={draft.type} options={draft.options} value={draft.defaultValue} members={members} disabled={readOnly} onChange={(value) => setDraft({ ...draft, defaultValue: value })} /><div className="property-editor-actions"><button className="primary-action" disabled={readOnly || saving}>{saving ? t("저장 중") : t("변경 저장")}</button>{property.active ? <button type="button" className="danger" disabled={readOnly} onClick={onDeactivate}><Trash2 size={13} />{t("제거")}</button> : <button type="button" disabled={readOnly} onClick={onRestore}><RotateCcw size={13} />{t("복원")}</button>}</div></form>;
}

function PropertyDefaultInput({ type, options, value, members, disabled = false, onChange, label = "생성 시 기본값" }: { label?: string; type: PropertyType; options: string[]; value: PropertyValue; members: TeamMember[]; disabled?: boolean; onChange: (value: PropertyValue) => void }) {
  if (type === "checkbox") return <label><span>{label}</span><input aria-label={label} disabled={disabled} type="checkbox" checked={Boolean(value)} onChange={(event) => onChange(event.target.checked)} /></label>;
  if (type === "select") return <label><span>{label}</span><select aria-label={label} disabled={disabled} value={typeof value === "string" ? value : ""} onChange={(event) => onChange(event.target.value || null)}><option value="">{t("없음")}</option>{options.map((option) => <option key={option}>{option}</option>)}</select></label>;
  if (type === "member") return <label><span>{label}</span><select aria-label={label} disabled={disabled} value={typeof value === "string" ? value : ""} onChange={(event) => onChange(event.target.value || null)}><option value="">{t("없음")}</option>{members.filter((member) => member.status === "active").map((member) => <option value={member.id} key={member.id}>{member.displayName}</option>)}</select></label>;
  if (type === "members") return <label><span>{label}</span><select aria-label={label} disabled={disabled} multiple value={Array.isArray(value) ? value : []} onChange={(event) => onChange(Array.from(event.target.selectedOptions, (option) => option.value))}>{members.filter((member) => member.status === "active").map((member) => <option value={member.id} key={member.id}>{member.displayName}</option>)}</select></label>;
  return <label><span>{label}</span><input aria-label={label} disabled={disabled} type={type === "number" ? "number" : type === "date" ? "date" : "text"} value={value === null || Array.isArray(value) ? "" : String(value)} onChange={(event) => onChange(type === "number" ? (event.target.value ? Number(event.target.value) : null) : event.target.value || null)} /></label>;
}

function ProjectTemplateManager({ workspaceId, readOnly, onNotice }: { workspaceId: string; readOnly: boolean; onNotice: (message: string) => void }) {
  const confirmAction = useAppConfirm();
  const cacheKey = `templates:${workspaceId}`;
  const [templates, setTemplates] = useState<ProjectTemplate[] | null>(() => projectTemplateMemoryCache.get(cacheKey) ?? null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [templateName, setTemplateName] = useState("");
  const [creatingTemplate, setCreatingTemplate] = useState(false);
  const [saving, setSaving] = useState(false);
  const selected = templates?.find((template) => template.id === selectedId) ?? null;

  useEffect(() => {
    let active = true;
    if (projectTemplateMemoryCache.has(cacheKey) && viewCacheIsFresh(cacheKey)) return () => { active = false; };
    void fetch("/api/project-templates").then(async (response) => response.ok ? response.json() as Promise<{ templates: ProjectTemplate[] }> : Promise.reject()).then((data) => {
      if (!active) return;
      projectTemplateMemoryCache.set(cacheKey, data.templates);
      markViewCacheFresh(cacheKey);
      setTemplates(data.templates);
      setSelectedId(data.templates[0]?.id ?? null);
    }).catch(() => setTemplates([]));
    return () => { active = false; };
  }, [cacheKey]);
  useEffect(() => {
    if (!templates) return;
    projectTemplateMemoryCache.set(cacheKey, templates);
    markViewCacheFresh(cacheKey);
  }, [cacheKey, templates]);

  async function createTemplate(event: FormEvent) {
    event.preventDefault();
    if (readOnly) return;
    const name = templateName.trim();
    if (!name) return;
    const content = JSON.stringify([{ type: "heading", props: { level: 2 }, content: "목적" }, { type: "paragraph", content: "" }, { type: "heading", props: { level: 2 }, content: "배경" }, { type: "paragraph", content: "" }, { type: "heading", props: { level: 2 }, content: "범위" }, { type: "paragraph", content: "" }, { type: "heading", props: { level: 2 }, content: "성공 기준" }, { type: "checkListItem", props: { checked: false }, content: "" }]);
    const response = await fetch("/api/project-templates", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name, content, plainText: "목적\n\n배경\n\n범위\n\n성공 기준" }) });
    const data = await response.json() as { template?: ProjectTemplate; error?: string };
    if (!response.ok || !data.template) { onNotice(apiError(data, "템플릿을 만들지 못했습니다.")); return; }
    setTemplates((current) => [data.template!, ...(current ?? [])]);
    setSelectedId(data.template.id);
    setTemplateName("");
    setCreatingTemplate(false);
    onNotice(t("새 본문 템플릿을 만들었습니다."));
  }

  async function patchTemplate(id: string, patch: Partial<ProjectTemplate>, quiet = false) {
    setSaving(true);
    const response = await fetch("/api/project-templates", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id, ...patch }) });
    const data = await response.json() as { template?: ProjectTemplate; error?: string };
    setSaving(false);
    if (!response.ok || !data.template) { onNotice(apiError(data, "템플릿을 저장하지 못했습니다.")); return; }
    setTemplates((current) => current?.map((template) => template.id === id ? data.template! : template) ?? []);
    if (!quiet) onNotice(t("템플릿을 저장했습니다."));
  }

  async function duplicateTemplate(template: ProjectTemplate) {
    let name = t("{value1} 복사본", { value1: messageValue(template.name) });
    let suffix = 2;
    while (templates?.some((entry) => entry.name === name)) name = t("{value1} 복사본 {value2}", { value1: messageValue(template.name), value2: messageValue(suffix++) });
    const response = await fetch("/api/project-templates", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name, description: template.description, content: template.content, plainText: template.plainText }) });
    const data = await response.json() as { template?: ProjectTemplate };
    if (!response.ok || !data.template) { onNotice(t("템플릿을 복제하지 못했습니다.")); return; }
    setTemplates((current) => [data.template!, ...(current ?? [])]);
    setSelectedId(data.template.id);
  }

  async function removeTemplate(template: ProjectTemplate) {
    if (!await confirmAction({ title: t("본문 템플릿 삭제"), message: t("'{value1}' 템플릿을 삭제합니다.\n이미 적용된 Project 문서는 바뀌지 않습니다.", { value1: messageValue(template.name) }), confirmLabel: t("템플릿 삭제"), danger: true })) return;
    const response = await fetch(`/api/project-templates?id=${encodeURIComponent(template.id)}`, { method: "DELETE" });
    if (!response.ok) { onNotice(t("템플릿을 삭제하지 못했습니다.")); return; }
    setTemplates((current) => current?.filter((entry) => entry.id !== template.id) ?? []);
    setSelectedId((templates ?? []).find((entry) => entry.id !== template.id)?.id ?? null);
  }

  return <section className="project-template-manager"><header><div><h2>{t("본문 템플릿")}</h2><p>{t("속성과 Task를 포함하지 않는 Project 문서 양식을 관리합니다.")}</p></div><button disabled={readOnly} onClick={() => setCreatingTemplate(true)}><Plus size={13} />{t("새 템플릿")}</button></header>{templates === null ? <div className="project-editor-loading"><LoaderCircle size={16} />{t("템플릿을 불러오는 중")}</div> : <div className="project-template-layout"><aside className="project-template-list">{creatingTemplate && <form className="project-template-create" onSubmit={(event) => void createTemplate(event)}><input aria-label={t("새 템플릿 이름")} value={templateName} onChange={(event) => setTemplateName(event.target.value)} placeholder={t("템플릿 이름")} /><button disabled={!templateName.trim()} aria-label={t("템플릿 만들기")}><Check size={13} /></button><button type="button" aria-label={t("템플릿 만들기 취소")} onClick={() => { setCreatingTemplate(false); setTemplateName(""); }}><X size={13} /></button></form>}{templates.map((template) => <button className={selectedId === template.id ? "selected" : ""} onClick={() => setSelectedId(template.id)} key={template.id}><BookTemplate size={14} /><span><b>{template.name}</b><small>{formatDateTime(template.updatedAt)}</small></span></button>)}{!templates.length && !creatingTemplate && <EmptyState icon={BookTemplate} title={t("저장된 템플릿이 없습니다")} />}</aside><div className="project-template-editor">{selected ? <><div className="project-template-meta"><input disabled={readOnly} defaultValue={selected.name} onBlur={(event) => event.target.value.trim() !== selected.name && void patchTemplate(selected.id, { name: event.target.value })} aria-label={t("템플릿 이름")} /><textarea disabled={readOnly} defaultValue={selected.description} onBlur={(event) => event.target.value !== selected.description && void patchTemplate(selected.id, { description: event.target.value })} placeholder={t("템플릿 설명")} rows={2} /><div><span>{saving ? t("저장 중") : t("자동 저장")}</span>{!readOnly && <><button onClick={() => void duplicateTemplate(selected)}><Copy size={13} />{t("복제")}</button><button className="danger" onClick={() => void removeTemplate(selected)}><Trash2 size={13} />{t("삭제")}</button></>}</div></div><ClientProjectBlockEditor key={selected.id} initialContent={selected.content} editable={!readOnly} onChange={readOnly ? undefined : (change) => void patchTemplate(selected.id, change, true)} /></> : <EmptyState icon={BookTemplate} title={t("편집할 템플릿을 선택하세요")} />}</div></div>}</section>;
}

function WorkspaceAvatar({ workspace, className = "" }: { workspace?: Pick<WorkspaceSummary, "name" | "avatarUrl">; className?: string }) {
  const [failedUrl, setFailedUrl] = useState<string | null>(null);
  return (
    <span className={`workspace-avatar ${className}`.trim()} aria-hidden="true">
      {workspace?.avatarUrl && failedUrl !== workspace.avatarUrl
        ? <img src={workspace.avatarUrl} alt="" onError={() => setFailedUrl(workspace.avatarUrl)} />
        : workspace?.name.slice(0, 1).toLocaleUpperCase() || "O"}
    </span>
  );
}

function WorkspaceAvatarDialog({ workspace, onClose, onChanged, onNotice }: {
  workspace: WorkspaceSummary;
  onClose: () => void;
  onChanged: (avatarUrl: string | null, avatarUpdatedAt: string | null) => void;
  onNotice: (message: string, tone?: NoticeTone) => void;
}) {
  const confirmAction = useAppConfirm();
  const inputRef = useRef<HTMLInputElement>(null);
  const [prompt, setPrompt] = useState("");
  const [preview, setPreview] = useState<{ blob: Blob; url: string } | null>(null);
  const [busy, setBusy] = useState<"upload" | "generate" | "remove" | null>(null);
  const [error, setError] = useState("");

  useEffect(() => () => { if (preview) URL.revokeObjectURL(preview.url); }, [preview]);

  async function chooseImage(file: File | undefined) {
    if (!file) return;
    setError("");
    try {
      const blob = await prepareWorkspaceAvatar(file);
      setPreview((current) => {
        if (current) URL.revokeObjectURL(current.url);
        return { blob, url: URL.createObjectURL(blob) };
      });
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : t("이미지를 읽지 못했습니다."));
    } finally {
      if (inputRef.current) inputRef.current.value = "";
    }
  }

  async function applyUpload() {
    if (!preview || busy) return;
    setBusy("upload");
    setError("");
    const form = new FormData();
    form.append("image", new File([preview.blob], "workspace-avatar.webp", { type: "image/webp" }));
    try {
      const response = await fetch("/api/workspaces/avatar", { method: "PUT", body: form });
      const data = await response.json().catch(() => ({})) as { avatarUrl?: string | null; avatarUpdatedAt?: string | null; error?: string };
      if (!response.ok) throw new Error(apiError(data, "이미지를 저장하지 못했습니다."));
      onChanged(data.avatarUrl ?? null, data.avatarUpdatedAt ?? null);
      setPreview(null);
      onNotice(t("워크스페이스 이미지를 적용했습니다."), "success");
    } catch (uploadError) {
      setError(uploadError instanceof Error ? uploadError.message : t("이미지를 저장하지 못했습니다."));
    } finally {
      setBusy(null);
    }
  }

  async function generateImage() {
    if (busy) return;
    setBusy("generate");
    setError("");
    try {
      const response = await fetch("/api/workspaces/avatar", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt }),
      });
      const data = await response.json().catch(() => ({})) as { avatarUrl?: string | null; avatarUpdatedAt?: string | null; error?: string };
      if (!response.ok) throw new Error(apiError(data, "AI 이미지를 만들지 못했습니다."));
      onChanged(data.avatarUrl ?? null, data.avatarUpdatedAt ?? null);
      setPreview(null);
      onNotice(t("AI 이미지를 만들어 바로 적용했습니다."), "success");
    } catch (generationError) {
      setError(generationError instanceof Error ? generationError.message : t("AI 이미지를 만들지 못했습니다."));
    } finally {
      setBusy(null);
    }
  }

  async function removeImage() {
    if (busy || !workspace.avatarUrl) return;
    if (!await confirmAction({ title: t("워크스페이스 이미지 초기화"), message: t("현재 이미지를 지우고 워크스페이스 이름의 첫 글자로 되돌립니다."), confirmLabel: t("이미지 지우기"), danger: true })) return;
    setBusy("remove");
    setError("");
    try {
      const response = await fetch("/api/workspaces/avatar", { method: "DELETE" });
      const data = await response.json().catch(() => ({})) as { avatarUpdatedAt?: string | null; error?: string };
      if (!response.ok) throw new Error(apiError(data, "이미지를 지우지 못했습니다."));
      onChanged(null, data.avatarUpdatedAt ?? null);
      setPreview(null);
      onNotice(t("워크스페이스 이미지를 초기화했습니다."), "success");
    } catch (removeError) {
      setError(removeError instanceof Error ? removeError.message : t("이미지를 지우지 못했습니다."));
    } finally {
      setBusy(null);
    }
  }

  return (
    <OverlayDialog title={t("워크스페이스 이미지")} initialFocus="textarea" onRequestClose={() => onClose()}>
      {(requestClose) => <section className="workspace-avatar-dialog">
        <header><div><h2>{t("워크스페이스 이미지")}</h2><p>{t("{name}을 알아보기 쉽게 꾸며보세요.", { name: workspace.name })}</p></div><button className="icon-button" onClick={() => requestClose("close-button")} aria-label={t("워크스페이스 이미지 닫기")}><X size={17} /></button></header>
        <div className="workspace-avatar-stage">
          {preview ? <img src={preview.url} alt={t("업로드할 워크스페이스 이미지 미리보기")} /> : <WorkspaceAvatar workspace={workspace} className="workspace-avatar-preview" />}
          <div><b>{preview ? t("이 이미지로 바꿀까요?") : workspace.avatarUrl ? t("현재 이미지") : t("기본 이미지")}</b><p>{t("정사각형으로 잘라 작은 화면에서도 선명하게 표시합니다.")}</p></div>
        </div>
        <section className="workspace-avatar-option">
          <div><Upload size={16} /><span><b>{t("내 이미지 업로드")}</b><small>{t("PNG, JPEG, WebP · 최대 5MB")}</small></span></div>
          <input ref={inputRef} type="file" accept="image/png,image/jpeg,image/webp" onChange={(event) => void chooseImage(event.target.files?.[0])} hidden />
          <div className="workspace-avatar-option-actions">
            <button type="button" onClick={() => inputRef.current?.click()} disabled={Boolean(busy)}>{preview ? t("다른 이미지") : t("이미지 선택")}</button>
            {preview && <button type="button" className="primary" onClick={() => void applyUpload()} disabled={Boolean(busy)}>{busy === "upload" ? <><LoaderCircle className="spin" size={14} />{t("적용 중")}</> : t("이 이미지 사용")}</button>}
          </div>
        </section>
        <section className="workspace-avatar-option workspace-avatar-ai">
          <div><Sparkles size={16} /><span><b>{t("AI로 만들기")}</b><small>{t("설명을 바꾸고 다시 생성할 수 있습니다.")}</small></span></div>
          <textarea rows={3} maxLength={240} value={prompt} onChange={(event) => setPrompt(event.target.value)} placeholder={t("예: 따뜻한 주황색의 연결된 원, 단순하고 활기찬 느낌")} aria-label={t("AI 이미지 설명")} />
          <button type="button" className="primary" onClick={() => void generateImage()} disabled={Boolean(busy)}>{busy === "generate" ? <><LoaderCircle className="spin" size={14} />{t("AI가 만드는 중")}</> : <><Sparkles size={14} />{t("생성하고 바로 적용")}</>}</button>
          {busy === "generate" && <p className="workspace-avatar-wait">{t("이미지 생성은 최대 1~2분 걸릴 수 있습니다. 창을 닫지 마세요.")}</p>}
        </section>
        {error && <p className="workspace-avatar-error" role="alert">{error}</p>}
        <footer><button type="button" className="danger-text" onClick={() => void removeImage()} disabled={Boolean(busy) || !workspace.avatarUrl}><Trash2 size={14} />{t("기본 이미지로 되돌리기")}</button><button type="button" onClick={() => requestClose("close-button")}>{t("닫기")}</button></footer>
      </section>}
    </OverlayDialog>
  );
}

async function prepareWorkspaceAvatar(file: File) {
  if (!/^image\/(png|jpeg|webp)$/.test(file.type)) throw new Error(t("PNG, JPEG, WebP 이미지만 선택할 수 있습니다."));
  if (file.size > 10 * 1024 * 1024) throw new Error(t("원본 이미지는 10MB 이하여야 합니다."));
  const image = await createImageBitmap(file);
  try {
    const size = Math.min(image.width, image.height);
    const canvas = document.createElement("canvas");
    canvas.width = 512;
    canvas.height = 512;
    const context = canvas.getContext("2d");
    if (!context) throw new Error(t("이미지를 처리하지 못했습니다."));
    context.drawImage(image, (image.width - size) / 2, (image.height - size) / 2, size, size, 0, 0, 512, 512);
    const blob = await new Promise<Blob>((resolve, reject) => canvas.toBlob((result) => result ? resolve(result) : reject(new Error(t("이미지를 처리하지 못했습니다."))), "image/webp", 0.88));
    if (blob.size > 5 * 1024 * 1024) throw new Error(t("처리한 이미지가 5MB를 초과했습니다."));
    return blob;
  } finally {
    image.close();
  }
}

function WorkspaceSettingsPanel({ currentWorkspace, scheduledWorkspaces, teamData, properties, teamMembers, tab, requestedGroupHandle, slack, slackOAuthIssue, integrationLoading, integrationLoadError, workspaceSaving, onTabChange, onClose, onIdentityChanged, onTeamChange, onPropertiesChanged, onOpenAvatar, onCleanup, onDeleteWorkspace, onRestoreWorkspace, onPermanentlyDeleteWorkspace, onSlackChange, onRefreshIntegrations, onNotice }: { currentWorkspace: WorkspaceSummary; scheduledWorkspaces: WorkspaceSummary[]; teamData: TeamData | null; properties: PropertyDefinition[]; teamMembers: TeamMember[]; tab: WorkspaceSettingsTab; requestedGroupHandle: string | null; slack: SlackConnectionStatus | null; slackOAuthIssue: SlackOAuthIssue | null; integrationLoading: boolean; integrationLoadError: boolean; workspaceSaving: boolean; onTabChange: (tab: WorkspaceSettingsTab) => void; onClose: () => void; onIdentityChanged: (name: string) => void; onTeamChange: (team: TeamData | null) => void; onPropertiesChanged: (properties: PropertyDefinition[]) => void; onOpenAvatar: () => void; onCleanup: () => void; onDeleteWorkspace: (workspace: WorkspaceSummary) => void; onRestoreWorkspace: (workspace: WorkspaceSummary) => void; onPermanentlyDeleteWorkspace: (workspace: WorkspaceSummary) => void; onSlackChange: (status: SlackConnectionStatus | null) => void; onRefreshIntegrations: () => void; onNotice: (message: string) => void }) {
  const [projectSettingsTab, setProjectSettingsTab] = useState<"properties" | "templates">("properties");
  const canManageWorkspace = currentWorkspace.role === "owner" || currentWorkspace.role === "admin";
  const tabs: Array<{ id: WorkspaceSettingsTab; label: string; icon: LucideIcon; visible: boolean; count?: number }> = [
    { id: "general", label: "일반", icon: Settings2, visible: true },
    { id: "members", label: "멤버", icon: Users, visible: !currentWorkspace.personal, count: teamData?.members.length },
    { id: "groups", label: "그룹", icon: AtSign, visible: !currentWorkspace.personal },
    { id: "projects", label: "Project 설정", icon: Briefcase, visible: true },
    { id: "summary", label: "관리 요약", icon: Activity, visible: !currentWorkspace.personal },
    { id: "integrations", label: "자동화 봇", icon: Bot, visible: !currentWorkspace.personal },
    { id: "backups", label: "백업 및 복원", icon: Database, visible: canManageWorkspace },
    { id: "danger", label: "위험 구역", icon: AlertTriangle, visible: canManageWorkspace },
    { id: "scheduled", label: "삭제 예정", icon: Trash2, visible: scheduledWorkspaces.length > 0, count: scheduledWorkspaces.length },
  ];
  const visibleTabs = tabs.filter((entry) => entry.visible);
  const activeTab = visibleTabs.some((entry) => entry.id === tab) ? tab : "general";

  return <OverlayDialog title={t("워크스페이스 설정")} variant="drawer" onRequestClose={() => onClose()}>{(requestClose) => <aside className="workspace-settings-panel">
    <header className="workspace-settings-header"><div><WorkspaceAvatar workspace={currentWorkspace} /><span><h2>{t("워크스페이스 설정")}</h2><p>{currentWorkspace.name} · {currentWorkspace.personal ? t("개인") : teamRoleLabel(currentWorkspace.role)}</p></span></div><button className="icon-button" onClick={() => requestClose("close-button")} aria-label={t("워크스페이스 설정 닫기")}><X size={18} /></button></header>
    <div className="workspace-settings-layout">
      <nav className="workspace-settings-nav" aria-label={t("워크스페이스 설정 메뉴")}>{visibleTabs.map((entry) => { const Icon = entry.icon; return <button key={entry.id} className={activeTab === entry.id ? "active" : ""} aria-current={activeTab === entry.id ? "page" : undefined} onClick={() => onTabChange(entry.id)}><Icon size={15} /><span>{entry.label}</span>{entry.count !== undefined && <b>{entry.count}</b>}</button>; })}</nav>
      <section className="workspace-settings-content">
        {activeTab === "general" && <div className="workspace-settings-section"><header><h3>{t("일반")}</h3></header><div className="workspace-profile-card"><WorkspaceAvatar workspace={currentWorkspace} className="workspace-profile-avatar" /><div><b>{currentWorkspace.name}</b><span>{currentWorkspace.personal ? t("개인 워크스페이스") : t("팀 워크스페이스")}</span><small>{t("내 권한 · {role}", { role: teamRoleLabel(currentWorkspace.role) })}</small></div>{!currentWorkspace.personal && canManageWorkspace && <button onClick={onOpenAvatar}><ImageIcon size={14} />{t("이미지 변경")}</button>}</div><WorkspaceIdentity workspaceId={currentWorkspace.id} onNameChanged={onIdentityChanged} />{!canManageWorkspace && <div className="workspace-settings-note"><Eye size={16} /><p>{t("읽기 전용")} · {t("이름과 주소 변경은 소유자 또는 관리자에게 요청해 주세요.")}</p></div>}</div>}
        {activeTab === "members" && <div className="workspace-settings-section team-settings-section"><header><h3>{t("멤버")}</h3><p>{t("초대, 역할과 워크스페이스 구성원을 관리합니다.")}</p></header><TeamPanel key={`${currentWorkspace.id}:members`} initialTeam={teamData} initialTab="members" initialGroupHandle={null} embedded onTeamChange={onTeamChange} onClose={onClose} onNotice={onNotice} /></div>}
        {activeTab === "groups" && <div className="workspace-settings-section team-settings-section"><header><h3>{t("그룹")}</h3><p>{t("조직 그룹과 구성원, Lead 권한을 관리합니다.")}</p></header><TeamPanel key={`${currentWorkspace.id}:groups`} initialTeam={teamData} initialTab="groups" initialGroupHandle={requestedGroupHandle} embedded onTeamChange={onTeamChange} onClose={onClose} onNotice={onNotice} /></div>}
        {activeTab === "projects" && <div className="workspace-project-settings"><header className="workspace-settings-section-header"><div><h3>{t("Project 설정")}</h3><p>{t("모든 Project에서 함께 사용하는 속성과 본문 템플릿입니다.")}</p></div><div className="workspace-project-tabs" role="tablist" aria-label={t("Project 설정")}><button role="tab" aria-selected={projectSettingsTab === "properties"} className={projectSettingsTab === "properties" ? "active" : ""} onClick={() => setProjectSettingsTab("properties")}><Settings2 size={14} />{t("속성")}</button><button role="tab" aria-selected={projectSettingsTab === "templates"} className={projectSettingsTab === "templates" ? "active" : ""} onClick={() => setProjectSettingsTab("templates")}><BookTemplate size={14} />{t("템플릿")}</button></div></header>{projectSettingsTab === "properties" ? <ProjectPropertyManager workspaceId={currentWorkspace.id} properties={properties} teamMembers={teamMembers} readOnly={!canManageWorkspace} onChanged={(next) => onPropertiesChanged([...next].sort((left, right) => left.sortOrder - right.sortOrder))} onNotice={onNotice} /> : <ProjectTemplateManager workspaceId={currentWorkspace.id} readOnly={!canManageWorkspace} onNotice={onNotice} />}</div>}
        {activeTab === "backups" && <WorkspaceBackups key={`${currentWorkspace.id}:backups`} workspaceId={currentWorkspace.id} workspaceName={currentWorkspace.name} onNotice={onNotice} />}
        {activeTab === "summary" && <WorkspaceManagementSummary key={`${currentWorkspace.id}:summary`} />}
        {activeTab === "integrations" && <WorkspaceSlackIntegration key={`${currentWorkspace.id}:bots`} slack={slack} slackOAuthIssue={slackOAuthIssue} loading={integrationLoading} loadError={integrationLoadError} workspaceName={currentWorkspace.name} canManageSlack={canManageWorkspace} onSlackChange={onSlackChange} onRefresh={onRefreshIntegrations} onNotice={onNotice} />}
        {activeTab === "danger" && <div className="workspace-settings-section danger-settings"><header><h3>{t("위험 구역")}</h3><p>{t("현재 워크스페이스의 실행 데이터와 워크스페이스 자체를 정리합니다.")}</p></header><article><div><b>{t("OKR 실행 데이터 클린업")}</b><p>{t("워크스페이스와 그룹은 유지하고 OKR·Project·Task를 휴지통으로 이동합니다.")}</p></div><button onClick={onCleanup}><Trash2 size={14} />{t("클린업 열기")}</button></article>{!currentWorkspace.personal && currentWorkspace.role === "owner" && <article><div><b>{t("워크스페이스 삭제 예약")}</b><p>{t("즉시 접근을 중단하고 30일 동안 복구할 수 있도록 삭제 예약합니다.")}</p></div><button onClick={() => onDeleteWorkspace(currentWorkspace)} disabled={workspaceSaving}><Trash2 size={14} />{t("삭제 예약")}</button></article>}</div>}
        {activeTab === "scheduled" && <div className="workspace-settings-section scheduled-settings"><header><h3>{t("삭제 예정 워크스페이스")}</h3><p>{t("삭제 예약된 워크스페이스를 복구하거나 즉시 영구삭제합니다.")}</p></header><div className="scheduled-workspace-list">{scheduledWorkspaces.map((workspace) => <article key={workspace.id}><WorkspaceAvatar workspace={workspace} /><div><b>{workspace.name}</b><small>{workspaceDeletionLabel(workspace.scheduledDeletionAt)}</small></div><button onClick={() => onRestoreWorkspace(workspace)} disabled={workspaceSaving}><RotateCcw size={14} />{t("복구")}</button><button className="danger" onClick={() => onPermanentlyDeleteWorkspace(workspace)} disabled={workspaceSaving}><Trash2 size={14} />{t("영구삭제")}</button></article>)}</div></div>}
      </section>
    </div>
  </aside>}</OverlayDialog>;
}

function PropertyPanel({ user, displayName, themeMode, onThemeModeChange, onClose, onSignOut }: { user: AuthUser | null; displayName: string; themeMode: ThemeMode; onThemeModeChange: (mode: ThemeMode) => void; onClose: () => void; onSignOut: () => void }) {
  const language = useLanguage();
  const [languageDirty, setLanguageDirty] = useState(false);
  return <OverlayDialog title={t("내 설정")} variant="drawer" dirty={languageDirty} onRequestClose={() => { if (user && language.preferences) void applyAccountLanguage(user.id, language.preferences, { commit: true }); onClose(); }}>{(requestClose) => <aside className="property-panel"><header><div><h2>{t("내 설정")}</h2><p>{t("내 계정과 화면 설정")}</p></div><button className="icon-button" onClick={() => requestClose("close-button")} aria-label={t("내 설정 닫기")} title={t("내 설정 닫기")}><X size={17} /></button></header><section className="settings-section"><h3>{t("내 계정")}</h3><div className="settings-account-card"><span className="avatar">{displayName.slice(0, 1).toLocaleUpperCase()}</span><div><b>{displayName}</b><small>{user?.email || t("로그인 계정")}</small></div></div></section><section className="settings-section appearance-settings"><h3>{t("테마")}</h3><ThemePicker value={themeMode} onChange={onThemeModeChange} /><p>{t("선택한 테마는 이 브라우저에 저장됩니다.")}</p></section>{user && <LanguageSettings userId={user.id} onDirtyChange={setLanguageDirty} />}<MarketingConsentSettings /><section className="settings-account-actions"><button onClick={onSignOut}><LogOut size={13} />{t("Google 계정 로그아웃")}</button></section></aside>}</OverlayDialog>;
}


function TeamPanel({ initialTeam, initialTab, initialGroupHandle, embedded = false, onTeamChange, onClose, onNotice }: { initialTeam: TeamData | null; initialTab: "members" | "groups"; initialGroupHandle: string | null; embedded?: boolean; onTeamChange: (team: TeamData | null) => void; onClose: () => void; onNotice: (message: string) => void }) {
  const [team, setTeam] = useState<TeamData | null>(initialTeam);
  const initialTeamRef = useRef(initialTeam);
  const [groups, setGroups] = useState<WorkspaceGroup[] | null>(null);
  const [tab, setTab] = useState<"members" | "groups">(initialTab);
  const [selectedGroupId, setSelectedGroupId] = useState<string | null>(null);
  const [groupDetail, setGroupDetail] = useState<GroupDetailData | null>(null);
  const [showArchived, setShowArchived] = useState(false);
  const [email, setEmail] = useState("");
  const [inviteDisplayName, setInviteDisplayName] = useState("");
  const [editingMemberId, setEditingMemberId] = useState<string | null>(null);
  const [memberNameDraft, setMemberNameDraft] = useState("");
  const memberNameInputRef = useRef<HTMLInputElement>(null);
  const [role, setRole] = useState<Exclude<TeamRole, "owner">>("member");
  const [groupName, setGroupName] = useState("");
  const [groupColor, setGroupColor] = useState<GroupColor>("blue");
  const [groupVisibility, setGroupVisibility] = useState<GroupVisibility>("open");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    Promise.all([
      initialTeamRef.current ? Promise.resolve(initialTeamRef.current) : fetch("/api/team").then(async (response) => response.ok ? response.json() as Promise<TeamData> : Promise.reject()),
      fetch("/api/groups?includeArchived=true").then(async (response) => response.ok ? response.json() as Promise<{ groups: WorkspaceGroup[] }> : Promise.reject()),
    ])
      .then(([loadedTeam, groupData]) => { setTeam(loadedTeam); setGroups(groupData.groups); })
      .catch(() => setError(t("팀 정보를 불러오지 못했습니다.")));
  }, []);

  useEffect(() => {
    if (!selectedGroupId) return;
    const controller = new AbortController();
    fetch(`/api/group-members?groupId=${encodeURIComponent(selectedGroupId)}`, { signal: controller.signal })
      .then(async (response) => response.ok ? response.json() as Promise<GroupDetailData> : Promise.reject())
      .then((data) => setGroupDetail(data))
      .catch((loadError: unknown) => { if (!(loadError instanceof DOMException && loadError.name === "AbortError")) setError(t("그룹 정보를 불러오지 못했습니다.")); });
    return () => controller.abort();
  }, [selectedGroupId]);

  useEffect(() => {
    if (!initialGroupHandle || !groups?.length || selectedGroupId) return;
    const group = groups.find((entry) => entry.handle === initialGroupHandle);
    const timeout = window.setTimeout(() => {
      if (!group) {
        setError(t("주소에 해당하는 그룹을 찾지 못했습니다."));
        return;
      }
      setTab("groups");
      setGroupDetail(null);
      setSelectedGroupId(group.id);
      const url = new URL(window.location.href);
      url.searchParams.set("group", group.handle);
      window.history.replaceState(null, "", url);
    }, 0);
    return () => window.clearTimeout(timeout);
  }, [groups, initialGroupHandle, selectedGroupId]);

  useEffect(() => {
    if (!editingMemberId) return;
    memberNameInputRef.current?.focus();
    memberNameInputRef.current?.select();
  }, [editingMemberId]);

  function clearGroupUrl() {
    const url = new URL(window.location.href);
    url.searchParams.delete("group");
    window.history.replaceState(null, "", url);
  }

  function applyMembers(members: TeamMember[]) {
    if (!team) return;
    const next = { ...team, members };
    setTeam(next);
    onTeamChange(next);
  }

  function applyInvitations(invitations: TeamInvitation[], emailConfigured = team?.invitationEmailConfigured ?? false) {
    if (!team) return;
    const next = { ...team, invitations, invitationEmailConfigured: emailConfigured };
    setTeam(next);
    onTeamChange(next);
  }

  function openGroup(id: string) {
    setGroupDetail(null);
    setSelectedGroupId(id);
    const group = groups?.find((entry) => entry.id === id);
    if (group) {
      const url = new URL(window.location.href);
      url.searchParams.set("group", group.handle);
      window.history.replaceState(null, "", url);
    }
  }

  async function invite(event: FormEvent) {
    event.preventDefault();
    if (!email.trim() || saving) return;
    setSaving(true);
    setError("");
    const response = await fetch("/api/team", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email, displayName: inviteDisplayName, role }) });
    const data = await response.json() as { invitation?: TeamInvitation; inviteUrl?: string; error?: string };
    setSaving(false);
    if (!response.ok || !data.invitation) {
      setError(apiError(data, "초대를 만들지 못했습니다."));
      return;
    }
    applyInvitations([data.invitation, ...(team?.invitations ?? [])], team?.invitationEmailConfigured || data.invitation.deliveryStatus === "sent");
    setEmail("");
    setInviteDisplayName("");
    setError("");
    onNotice(data.invitation.deliveryStatus === "sent" ? t("초대메일을 보냈습니다.") : t("초대는 만들었지만 메일을 보내지 못했습니다. 링크를 복사해 전달해 주세요."));
  }

  async function invitationAction(invitation: TeamInvitation, action: "resend" | "link") {
    setError("");
    const response = await fetch("/api/team/invitations", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id: invitation.id, action }) });
    const data = await response.json() as { invitation?: TeamInvitation; inviteUrl?: string; error?: string };
    if (!response.ok || !data.invitation || !data.inviteUrl) {
      setError(apiError(data, "초대 링크를 갱신하지 못했습니다."));
      return;
    }
    applyInvitations(
      (team?.invitations ?? []).map((entry) => entry.id === invitation.id ? data.invitation! : entry),
      team?.invitationEmailConfigured || data.invitation.deliveryStatus === "sent",
    );
    if (action === "link") {
      await navigator.clipboard.writeText(data.inviteUrl);
      onNotice(t("30일 동안 유효한 새 초대 링크를 복사했습니다."));
    } else {
      onNotice(data.invitation.deliveryStatus === "sent" ? t("초대메일을 다시 보냈습니다.") : t("메일 발송에 실패했습니다. 링크 복사를 이용해 주세요."));
    }
  }

  async function revokeInvitation(invitation: TeamInvitation) {
    const response = await fetch(`/api/team/invitations?id=${encodeURIComponent(invitation.id)}`, { method: "DELETE" });
    if (!response.ok) {
      const data = await response.json() as { error?: string };
      setError(apiError(data, "초대를 취소하지 못했습니다."));
      return;
    }
    applyInvitations((team?.invitations ?? []).filter((entry) => entry.id !== invitation.id));
    onNotice(t("초대를 취소했습니다."));
  }

  async function changeRole(member: TeamMember, nextRole: Exclude<TeamRole, "owner">) {
    const response = await fetch("/api/team", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id: member.id, role: nextRole }) });
    if (!response.ok) return;
    const data = await response.json() as { member: TeamMember };
    applyMembers((team?.members ?? []).map((entry) => entry.id === member.id ? data.member : entry));
    onNotice(t("멤버 역할을 변경했습니다."));
  }

  function editMemberName(member: TeamMember) {
    setEditingMemberId(member.id);
    setMemberNameDraft(member.displayName);
    setError("");
  }

  function cancelMemberNameEdit() {
    setEditingMemberId(null);
    setMemberNameDraft("");
  }

  async function saveMemberName(event: FormEvent, member: TeamMember) {
    event.preventDefault();
    const displayName = memberNameDraft.trim();
    if (!displayName || saving) return;
    if (displayName === member.displayName) {
      cancelMemberNameEdit();
      return;
    }
    setSaving(true);
    setError("");
    const response = await fetch("/api/team", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id: member.id, displayName }) });
    const data = await response.json() as { member?: TeamMember; error?: string };
    setSaving(false);
    if (!response.ok || !data.member) {
      setError(apiError(data, "멤버 실명을 저장하지 못했습니다."));
      return;
    }
    if (data.member.isCurrent) window.localStorage.setItem(profileNameConfirmationKey(data.member), data.member.displayName);
    applyMembers((team?.members ?? []).map((entry) => entry.id === data.member!.id ? data.member! : entry));
    cancelMemberNameEdit();
    setError("");
    onNotice(data.member.isCurrent ? t("내 실명을 저장했습니다.") : t("멤버 실명을 저장했습니다."));
  }

  async function remove(member: TeamMember) {
    const response = await fetch(`/api/team?id=${encodeURIComponent(member.id)}`, { method: "DELETE" });
    if (!response.ok) return;
    applyMembers((team?.members ?? []).filter((entry) => entry.id !== member.id));
    onNotice(t("팀에서 제거했습니다."));
  }

  async function createWorkspaceGroup(event: FormEvent) {
    event.preventDefault();
    if (!groupName.trim() || saving) return;
    setSaving(true);
    setError("");
    const response = await fetch("/api/groups", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: groupName, color: groupColor, visibility: groupVisibility }) });
    const data = await response.json() as { group?: WorkspaceGroup; error?: string };
    setSaving(false);
    if (!response.ok || !data.group) { setError(apiError(data, "그룹을 만들지 못했습니다.")); return; }
    setGroups((current) => [...(current ?? []), data.group!].sort((left, right) => left.name.localeCompare(right.name)));
    setGroupName("");
    openGroup(data.group.id);
    onNotice(t("그룹을 만들었습니다."));
  }

  function applyGroup(group: WorkspaceGroup) {
    setGroups((current) => current?.map((entry) => entry.id === group.id ? group : entry) ?? null);
    setGroupDetail((current) => current?.group.id === group.id ? { ...current, group } : current);
  }

  function removeGroupFromState(id: string) {
    setGroups((current) => current?.filter((entry) => entry.id !== id) ?? null);
    setSelectedGroupId(null);
    clearGroupUrl();
  }

  const visibleGroups = (groups ?? []).filter((group) => showArchived || !group.archived);
  const activeGroupCount = (groups ?? []).filter((group) => !group.archived).length;
  const panelDirty = Boolean(email.trim() || inviteDisplayName.trim() || groupName.trim() || editingMemberId);

  const panelContent = (requestClose?: (reason?: "close-button") => void) => (
      <aside className={`property-panel team-panel ${embedded ? "team-panel-embedded" : ""}`}>
        {!embedded && <header>
          <div className="team-panel-heading">{team && <WorkspaceAvatar workspace={team.workspace} />}<span><h2>{t("팀")}</h2><p>{team ? t("{value1} · {value2}명 · {value3}개 그룹", { value1: messageValue(team.workspace.name), value2: messageValue(team.members.length), value3: messageValue(activeGroupCount) }) : t("불러오는 중")}</p></span></div>
          <button className="icon-button" onClick={() => requestClose?.("close-button")} aria-label={t("닫기")}><X size={17} /></button>
        </header>}
        {!embedded && <div className="team-tabs" role="tablist" aria-label={t("팀 관리")}>
          <button role="tab" aria-selected={tab === "members"} className={tab === "members" ? "active" : ""} onClick={() => { setTab("members"); setSelectedGroupId(null); clearGroupUrl(); }}><Users size={14} />{t("멤버")}</button>
          <button role="tab" aria-selected={tab === "groups"} className={tab === "groups" ? "active" : ""} onClick={() => setTab("groups")}><AtSign size={14} />{t("그룹")}</button>
        </div>}
        {tab === "members" ? (
          <>
            {team?.canManage && team.workspace.kind === "team" && (
              <form className="team-invite" onSubmit={invite}>
                <label><span>{t("실명과 이메일로 초대")}</span><div><input value={inviteDisplayName} onChange={(event) => setInviteDisplayName(event.target.value)} maxLength={80} placeholder={t("홍길동")} aria-label={t("초대 실명")} /><input type="email" value={email} onChange={(event) => setEmail(event.target.value)} placeholder="name@company.com" aria-label={t("초대 이메일")} /><select value={role} onChange={(event) => setRole(event.target.value as Exclude<TeamRole, "owner">)} aria-label={t("초대 역할")}><option value="admin">{t("Admin")}</option><option value="member">{t("Member")}</option><option value="viewer">{t("Viewer")}</option></select><button disabled={!email.trim() || saving} aria-label={t("멤버 초대")} title={t("멤버 초대")}><UserPlus size={14} /></button></div></label>
                {!team.invitationEmailConfigured && <p className="team-invite-warning">{t("메일 발송 설정이 없어 초대 링크로만 전달할 수 있습니다.")}</p>}
              </form>
            )}
            {team?.workspace.kind === "personal" && <p className="team-invite-warning personal">{t("멤버 초대는 팀 워크스페이스에서 사용할 수 있습니다.")}</p>}
            {error && <p className="team-panel-error">{error}</p>}
            <div className="team-list">
              {team ? team.members.map((member) => {
                const canEditName = team.canManage;
                const editingName = editingMemberId === member.id;
                return (
                  <div className="team-member" key={member.id}>
                    <span className="team-avatar">{memberInitial(member)}</span>
                    <div className="team-member-identity">
                      {editingName ? (
                        <form className="member-name-editor" onSubmit={(event) => void saveMemberName(event, member)}>
                          <input ref={memberNameInputRef} value={memberNameDraft} onChange={(event) => setMemberNameDraft(event.target.value)} maxLength={80} aria-label={t("{value1} 실명 편집", { value1: messageValue(member.displayName) })} />
                          <button disabled={!memberNameDraft.trim() || saving} aria-label={t("실명 저장")} title={t("실명 저장")}><Check size={12} /></button>
                          <button type="button" onClick={cancelMemberNameEdit} aria-label={t("수정 취소")} title={t("수정 취소")}><X size={12} /></button>
                        </form>
                      ) : canEditName ? (
                        <button className="member-name-button" onClick={() => editMemberName(member)} aria-label={t("{value1} 실명 수정", { value1: messageValue(member.displayName) })} title={t("실명 수정")}>
                          <span>{member.displayName}{member.isCurrent && <em>{t("나")}</em>}</span><Pencil size={11} />
                        </button>
                      ) : <b>{member.displayName}{member.isCurrent && <em>{t("나")}</em>}</b>}
                      <small>{member.email || (member.role === "owner" ? "Workspace owner" : t("이메일 없음"))}</small>
                    </div>
                    <span className="member-status member-active">{t("활성")}</span>
                    {team.canManage && member.role !== "owner" ? <select value={member.role} onChange={(event) => void changeRole(member, event.target.value as Exclude<TeamRole, "owner">)} aria-label={t("{value1} 역할", { value1: messageValue(member.displayName) })}><option value="admin">{t("Admin")}</option><option value="member">{t("Member")}</option><option value="viewer">{t("Viewer")}</option></select> : <span className="member-role">{teamRoleLabel(member.role)}</span>}
                    <div className="team-member-actions">
                      {team.canManage && member.role !== "owner" && !member.isCurrent && <button className="icon-button danger" onClick={() => void remove(member)} aria-label={t("팀에서 제거")} title={t("팀에서 제거")}><Trash2 size={13} /></button>}
                    </div>
                  </div>
                );
              }) : !error ? <EmptyState icon={Users} title={t("팀 정보를 불러오는 중입니다")} /> : <EmptyState icon={Users} title={error} />}
            </div>
            {team && team.invitations.length > 0 && <section className="team-invitations">
              <header><b>{t("대기 중인 초대")}</b><span>{team.invitations.length}</span></header>
              <div className="team-invitation-list">{team.invitations.map((invitation) => (
                <div className="team-invitation" key={invitation.id}>
                  <span className="team-avatar pending">{invitation.displayName.slice(0, 1).toLocaleUpperCase()}</span>
                  <div><b>{invitation.displayName}</b><small>{invitation.email} · {teamRoleLabel(invitation.role)}</small></div>
                  <span className={`invitation-delivery delivery-${invitation.deliveryStatus}`}>{invitation.status === "expired" ? t("만료됨") : invitation.deliveryStatus === "sent" ? t("메일 발송됨") : invitation.deliveryStatus === "failed" ? t("발송 실패") : invitation.deliveryStatus === "unavailable" ? t("링크 전달 필요") : t("미발송")}</span>
                  {team.canManage && <div className="team-member-actions">
                    <button className="icon-button" onClick={() => void invitationAction(invitation, "link")} aria-label={t("{value1} 초대 링크 복사", { value1: messageValue(invitation.displayName) })} title={t("새 초대 링크 복사")}><Copy size={13} /></button>
                    <button className="icon-button" onClick={() => void invitationAction(invitation, "resend")} aria-label={t("{value1} 초대메일 재전송", { value1: messageValue(invitation.displayName) })} title={t("초대메일 재전송")}><RotateCcw size={13} /></button>
                    <button className="icon-button danger" onClick={() => void revokeInvitation(invitation)} aria-label={t("{value1} 초대 취소", { value1: messageValue(invitation.displayName) })} title={t("초대 취소")}><Trash2 size={13} /></button>
                  </div>}
                </div>
              ))}</div>
            </section>}
          </>
        ) : selectedGroupId ? (
          groupDetail && team ? <GroupDetail detail={groupDetail} team={team} onBack={() => { setSelectedGroupId(null); clearGroupUrl(); }} onChange={setGroupDetail} onGroupChange={applyGroup} onDeleted={removeGroupFromState} onNotice={onNotice} /> : <EmptyState icon={Users} title={t("그룹 정보를 불러오는 중입니다")} />
        ) : (
          <>
            <div className="group-toolbar"><label className="archive-toggle"><input type="checkbox" checked={showArchived} onChange={(event) => setShowArchived(event.target.checked)} /><span /><Archive size={13} />{t("보관됨")}</label></div>
            {team?.canManage && <form className="group-create" onSubmit={createWorkspaceGroup}><div className="group-create-main"><input value={groupName} onChange={(event) => setGroupName(event.target.value)} placeholder={t("새 그룹 이름")} aria-label={t("새 그룹 이름")} /><button disabled={!groupName.trim() || saving} aria-label={t("그룹 만들기")} title={t("그룹 만들기")}><Plus size={14} /></button></div><div className="group-create-options"><div className="color-swatches" aria-label={t("그룹 색상")}>{groupColors.map((color) => <button type="button" className={groupColor === color ? "active" : ""} key={color} onClick={() => setGroupColor(color)} title={groupColorLabel(color)} aria-label={groupColorLabel(color)}><i className={`group-swatch group-${color}`} /></button>)}</div><div className="visibility-control"><button type="button" className={groupVisibility === "open" ? "active" : ""} onClick={() => setGroupVisibility("open")}><Users size={12} />{t("공개")}</button><button type="button" className={groupVisibility === "private" ? "active" : ""} onClick={() => setGroupVisibility("private")}><LockKeyhole size={12} />{t("비공개")}</button></div></div>{error && <p>{error}</p>}</form>}
            <div className="group-list">{groups === null ? <EmptyState icon={Users} title={t("그룹을 불러오는 중입니다")} /> : visibleGroups.length ? visibleGroups.map((group) => <button className={`group-row ${group.archived ? "archived" : ""}`} key={group.id} onClick={() => openGroup(group.id)}><i className={`group-swatch group-${group.color}`} /><span><b>{group.name}</b><small>@{group.handle}</small></span><em>{group.visibility === "private" ? <LockKeyhole size={11} /> : <Users size={11} />}{group.memberCount}</em>{group.archived && <span className="group-archived">{t("보관됨")}</span>}<ChevronRight size={14} /></button>) : <EmptyState icon={Users} title={showArchived ? t("그룹이 없습니다") : t("활성 그룹이 없습니다")} />}</div>
          </>
        )}
      </aside>
  );
  if (embedded) return panelContent();
  return <OverlayDialog title={t("팀 관리")} variant="drawer" dirty={panelDirty} onRequestClose={() => onClose()}>{(requestClose) => panelContent(requestClose)}</OverlayDialog>;
}

function GroupDetail({ detail, team, onBack, onChange, onGroupChange, onDeleted, onNotice }: { detail: GroupDetailData; team: TeamData; onBack: () => void; onChange: (next: GroupDetailData) => void; onGroupChange: (group: WorkspaceGroup) => void; onDeleted: (id: string) => void; onNotice: (message: string) => void }) {
  const confirmAction = useAppConfirm();
  const [name, setName] = useState(detail.group.name);
  const [handle, setHandle] = useState(detail.group.handle);
  const [description, setDescription] = useState(detail.group.description);
  const [color, setColor] = useState<GroupColor>(detail.group.color);
  const [visibility, setVisibility] = useState<GroupVisibility>(detail.group.visibility);
  const [memberIds, setMemberIds] = useState<string[]>([]);
  const [memberRole, setMemberRole] = useState<GroupRole>("member");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const availableMembers = team.members.filter((member) => !detail.members.some((entry) => entry.memberId === member.id));
  const selectedWorkspaceMembers = pickMembers(team.members, memberIds);
  const selectedHasViewer = selectedWorkspaceMembers.some((member) => member.role === "viewer");
  const groupUrl = typeof window === "undefined" ? `/?group=${encodeURIComponent(detail.group.handle)}` : `${window.location.origin}${window.location.pathname}?group=${encodeURIComponent(detail.group.handle)}`;

  function copyGroupUrl() {
    void navigator.clipboard.writeText(groupUrl);
    onNotice(t("그룹 주소를 복사했습니다."));
  }

  async function save(event: FormEvent) {
    event.preventDefault();
    setSaving(true); setError("");
    const response = await fetch("/api/groups", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id: detail.group.id, name, handle, description, color, visibility }) });
    const data = await response.json() as { group?: WorkspaceGroup; error?: string };
    setSaving(false);
    if (!response.ok || !data.group) { setError(apiError(data, "그룹을 저장하지 못했습니다.")); return; }
    onGroupChange(data.group); onNotice(t("그룹을 저장했습니다."));
  }

  async function setArchived(archived: boolean) {
    const response = await fetch("/api/groups", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id: detail.group.id, archived }) });
    const data = await response.json() as { group?: WorkspaceGroup; error?: string };
    if (!response.ok || !data.group) { setError(apiError(data, "그룹 상태를 변경하지 못했습니다.")); return; }
    onGroupChange(data.group); onChange({ ...detail, group: data.group, canManageMembers: !archived && (team.canManage || data.group.isLead) }); onNotice(archived ? t("그룹을 보관했습니다.") : t("그룹을 복구했습니다."));
  }

  async function permanentlyDelete() {
    if (!await confirmAction({ title: t("그룹 삭제"), message: t("'{value1}' 그룹의 멤버와 설정이 함께 삭제됩니다.", { value1: messageValue(detail.group.name) }), confirmLabel: t("그룹 삭제"), danger: true })) return;
    setError("");
    if (!detail.group.archived) {
      const archiveResponse = await fetch("/api/groups", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id: detail.group.id, archived: true }) });
      if (!archiveResponse.ok) { const data = await archiveResponse.json() as { error?: string }; setError(apiError(data, "그룹을 보관하지 못했습니다.")); return; }
    }
    const response = await fetch(`/api/groups?id=${encodeURIComponent(detail.group.id)}`, { method: "DELETE" });
    if (!response.ok) { const data = await response.json() as { error?: string }; setError(apiError(data, "그룹을 삭제하지 못했습니다.")); return; }
    onDeleted(detail.group.id); onNotice(t("그룹을 삭제했습니다."));
  }

  async function addMember(event: FormEvent) {
    event.preventDefault();
    if (!memberIds.length) return;
    const added: GroupMember[] = [];
    for (const memberId of memberIds) {
      const response = await fetch("/api/group-members", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ groupId: detail.group.id, memberId, role: memberRole }) });
      const data = await response.json() as { member?: GroupMember; error?: string };
      if (!response.ok || !data.member) { setError(apiError(data, "그룹 멤버를 추가하지 못했습니다.")); return; }
      added.push(data.member);
    }
    const next = { ...detail, group: { ...detail.group, memberCount: detail.group.memberCount + added.length }, members: [...detail.members, ...added] };
    onChange(next); onGroupChange(next.group); setMemberIds([]); onNotice(t("{value1}명을 그룹에 추가했습니다.", { value1: messageValue(added.length) }));
  }

  async function changeGroupRole(member: GroupMember, role: GroupRole) {
    const response = await fetch("/api/group-members", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ groupId: detail.group.id, memberId: member.memberId, role }) });
    const data = await response.json() as { member?: GroupMember; error?: string };
    if (!response.ok || !data.member) { setError(apiError(data, "그룹 역할을 변경하지 못했습니다.")); return; }
    const group = member.isCurrent
      ? { ...detail.group, isLead: role === "lead", canEdit: team.canManage || role === "lead" }
      : detail.group;
    onChange({ ...detail, group, canManageMembers: !group.archived && (team.canManage || group.isLead), members: detail.members.map((entry) => entry.memberId === member.memberId ? data.member! : entry) });
    if (member.isCurrent) onGroupChange(group);
    onNotice(t("그룹 역할을 변경했습니다."));
  }

  async function removeMember(member: GroupMember) {
    const response = await fetch(`/api/group-members?groupId=${encodeURIComponent(detail.group.id)}&memberId=${encodeURIComponent(member.memberId)}`, { method: "DELETE" });
    if (!response.ok) { const data = await response.json() as { error?: string }; setError(apiError(data, "그룹에서 제거하지 못했습니다.")); return; }
    const group = { ...detail.group, memberCount: Math.max(0, detail.group.memberCount - 1), isMember: member.isCurrent ? false : detail.group.isMember, isLead: member.isCurrent ? false : detail.group.isLead, canEdit: member.isCurrent ? team.canManage : detail.group.canEdit };
    if (member.isCurrent && !team.canManage && group.visibility === "private") {
      onDeleted(group.id);
    } else {
      const next = { ...detail, group, canManageMembers: !group.archived && (team.canManage || group.isLead), members: detail.members.filter((entry) => entry.memberId !== member.memberId) };
      onChange(next); onGroupChange(group);
    }
    onNotice(member.isCurrent ? t("그룹에서 나갔습니다.") : t("그룹에서 멤버를 제거했습니다."));
  }

  return (
    <div className="group-detail">
      <header className="group-detail-head">
        <button className="icon-button" onClick={onBack} aria-label={t("그룹 목록")} title={t("그룹 목록")}><ArrowLeft size={16} /></button>
        <i className={`group-swatch group-${detail.group.color}`} />
        <div><b>{detail.group.name}</b><small>@{detail.group.handle}</small></div>
        <div className="group-head-actions">
          {detail.group.archived && <span className="group-archived">{t("보관됨")}</span>}
          <button className="icon-button" onClick={copyGroupUrl} aria-label={t("그룹 주소 복사")} title={t("그룹 주소 복사")}><Copy size={13} /></button>
          {detail.group.canArchive && <button className="icon-button danger" onClick={() => void permanentlyDelete()} aria-label={t("그룹 삭제")} title={t("그룹 삭제")}><Trash2 size={13} /></button>}
        </div>
      </header>
      <div className="group-address-row">
        <div><b>{t("그룹 주소")}</b><code>{groupUrl}</code></div>
        <button className="icon-button" onClick={copyGroupUrl} aria-label={t("그룹 주소 복사")} title={t("그룹 주소 복사")}><Copy size={13} /></button>
      </div>
      {detail.group.canEdit ? (
        <form className="group-detail-form" onSubmit={save}>
          <label><span>{t("이름")}</span><input value={name} onChange={(event) => setName(event.target.value)} maxLength={80} /></label>
          <label><span>{t("핸들")}</span><div className="handle-input"><AtSign size={13} /><input value={handle} onChange={(event) => setHandle(event.target.value)} maxLength={32} /></div></label>
          <label><span>{t("설명")}</span><textarea value={description} onChange={(event) => setDescription(event.target.value)} maxLength={500} rows={3} /></label>
          <div className="group-setting-row"><span>{t("색상")}</span><div className="color-swatches">{groupColors.map((entry) => <button type="button" className={color === entry ? "active" : ""} key={entry} onClick={() => setColor(entry)} title={groupColorLabel(entry)} aria-label={groupColorLabel(entry)}><i className={`group-swatch group-${entry}`} /></button>)}</div></div>
          <div className="group-setting-row"><span>{t("공개 범위")}</span><div className="visibility-control"><button type="button" className={visibility === "open" ? "active" : ""} onClick={() => setVisibility("open")}><Users size={12} />{t("공개")}</button><button type="button" className={visibility === "private" ? "active" : ""} onClick={() => setVisibility("private")}><LockKeyhole size={12} />{t("비공개")}</button></div></div>
          {error && <p className="form-error">{error}</p>}
          <div className="group-form-actions">
            <button className="save-group" disabled={!name.trim() || !handle.trim() || saving}><Check size={13} />{t("저장")}</button>
            {detail.group.canArchive && (detail.group.archived ? (
              <>
                <button type="button" onClick={() => void setArchived(false)}><RotateCcw size={13} />{t("복구")}</button>
                <button type="button" className="danger" onClick={() => void permanentlyDelete()}><Trash2 size={13} />{t("영구 삭제")}</button>
              </>
            ) : (
              <>
                <button type="button" onClick={() => void setArchived(true)}><Archive size={13} />{t("보관")}</button>
                <button type="button" className="danger" onClick={() => void permanentlyDelete()}><Trash2 size={13} />{t("삭제")}</button>
              </>
            ))}
          </div>
        </form>
      ) : (
        <div className="group-summary">
          <p>{detail.group.description || t("설명 없음")}</p>
          <span>{detail.group.visibility === "private" ? <LockKeyhole size={12} /> : <Users size={12} />}{detail.group.visibility === "private" ? t("비공개") : t("공개")}</span>
        </div>
      )}
      <section className="group-members">
        <header><b>{t("멤버")}</b><span>{detail.members.length}</span></header>
        {detail.canManageMembers && (
          <form className="group-member-add" onSubmit={addMember}>
            <MemberMentionPicker label={t("실명 태그")} members={availableMembers} selectedIds={memberIds} onChange={(ids) => {
              setMemberIds(ids);
              if (memberRole === "lead" && pickMembers(team.members, ids).some((member) => member.role === "viewer")) setMemberRole("member");
            }} placeholder={t("@실명 또는 이메일")} />
            <select value={memberRole} onChange={(event) => setMemberRole(event.target.value as GroupRole)} aria-label={t("그룹 역할")}>
              <option value="member">{t("Member")}</option>
              <option value="lead" disabled={selectedHasViewer}>Lead</option>
            </select>
            <button disabled={!memberIds.length} aria-label={t("그룹에 추가")} title={t("그룹에 추가")}><UserPlus size={13} /></button>
          </form>
        )}
        <div className="group-member-list">
          {detail.members.map((member) => (
            <div className="group-member-row" key={member.memberId}>
              <span className="team-avatar">{memberInitial(member)}</span>
              <div><b>{member.displayName}{member.isCurrent && <em>{t("나")}</em>}</b><small>{member.status === "invited" ? t("{value1} · 초대 대기", { value1: messageValue(member.email) }) : member.email || teamRoleLabel(member.workspaceRole)}</small></div>
              {detail.canManageMembers ? <select value={member.groupRole} onChange={(event) => void changeGroupRole(member, event.target.value as GroupRole)} aria-label={t("{value1} 그룹 역할", { value1: messageValue(member.displayName) })}><option value="lead" disabled={member.workspaceRole === "viewer"}>Lead</option><option value="member">{t("Member")}</option></select> : <span className="member-role">{member.groupRole === "lead" ? "Lead" : t("Member")}</span>}
              {detail.canManageMembers && <button className="icon-button danger" onClick={() => void removeMember(member)} aria-label={t("그룹에서 제거")} title={t("그룹에서 제거")}><X size={13} /></button>}
            </div>
          ))}
          {!detail.members.length && <EmptyState icon={Users} title={t("그룹 멤버가 없습니다")} />}
        </div>
      </section>
    </div>
  );
}


function AppIntegrationsView({ google, slack, loading, loadError, onGoogleChange, onRefresh, onNotice }: { google: GoogleConnectionStatus | null; slack: SlackConnectionStatus | null; loading: boolean; loadError: boolean; onGoogleChange: (status: GoogleConnectionStatus | null) => void; onRefresh: () => void; onNotice: (message: string) => void }) {
  const [disconnectingGoogle, setDisconnectingGoogle] = useState(false);

  async function disconnectGoogle() {
    setDisconnectingGoogle(true);
    const response = await fetch("/api/google/disconnect", { method: "POST" });
    setDisconnectingGoogle(false);
    if (!response.ok) { onNotice(t("Google 연결을 해제하지 못했습니다.")); return; }
    onGoogleChange(google ? { ...google, connected: false, email: null, displayName: null, connectedAt: null, updatedAt: null } : null);
    onNotice(t("Google Calendar 연결을 해제했습니다."));
  }

  function connectGoogle() {
    if (!google?.configured) return;
    window.location.href = `/api/google/auth?returnTo=${encodeURIComponent("/?view=integrations")}`;
  }

  const slackState = loadError && !slack ? "error" : slack?.state ?? "service_unavailable";
  const slackConnected = Boolean(slack?.connected && slackState !== "service_unavailable" && slackState !== "error");

  return <section className="integrations-page" aria-label={t("개인 앱 연동 설정")}>
    <section className="integration-intro">
      <div><h2>{t("내 계정에 연결된 앱")}</h2><p>{t("내 캘린더와 개인 Slack DM처럼 현재 사용자에게만 적용되는 연결입니다.")}</p></div>
      <button type="button" onClick={onRefresh} disabled={loading}><RefreshCw className={loading ? "spin" : ""} size={15} />{loading ? t("상태 확인 중") : t("연결 상태 새로고침")}</button>
    </section>

    <section className="integration-service-card google-service-card" aria-labelledby="google-integration-heading">
      <header><span className="integration-service-icon"><CalendarDays size={20} /></span><div><h3 id="google-integration-heading">Google Calendar</h3><p>{t("내 Task의 마감 일정을 개인 캘린더와 연결합니다.")}</p></div><strong className={`integration-status-badge ${google?.connected ? "connected" : google?.configured ? "idle" : "warning"}`}>{loading ? t("확인 중") : google?.connected ? t("연결 완료") : google?.configured ? t("연결 가능") : t("설정 확인 필요")}</strong></header>
      {loading ? <div className="integration-loading"><LoaderCircle className="spin" size={16} />{t("연결 상태를 확인하고 있습니다.")}</div> : google?.connected ? <div className="integration-service-actions"><div><b>{google.email}</b><span>{t("일정 생성 및 수정 권한으로 연결됨")}</span></div><button className="secondary-danger" onClick={() => void disconnectGoogle()} disabled={disconnectingGoogle}>{disconnectingGoogle ? t("해제 중") : t("연결 해제")}</button></div> : google?.configured ? <div className="integration-service-actions"><div><b>{t("개인 연결")}</b><span>{t("현재 사용자에게만 적용됩니다.")}</span></div><button onClick={connectGoogle}>{t("Google로 연결")}</button></div> : <div className="integration-state-message warning"><AlertTriangle size={17} /><div><b>{t("Google 연결 설정을 확인할 수 없습니다")}</b><p>{t("현재 사용자가 입력할 설정은 없습니다. 상태를 다시 확인해 주세요.")}</p></div><button onClick={onRefresh}>{t("다시 확인")}</button></div>}
    </section>

    <section className="integration-service-card slack-service-card" aria-labelledby="personal-slack-heading">
      <header><span className="integration-service-icon slack"><Hash size={20} /></span><div><h3 id="personal-slack-heading">{t("Slack 개인 DM")}</h3><p>{t("내 데일리 알림 사용 여부와 수신 시간을 설정합니다. 팀 설치·채널·자동화는 워크스페이스 설정에서 관리합니다.")}</p></div><strong className={`integration-status-badge ${slackConnected ? "connected" : slackState}`}>{loading ? t("확인 중") : slackConnected ? t("사용 가능") : t("팀 연결 필요")}</strong></header>
      {loading ? <div className="integration-loading"><LoaderCircle className="spin" size={16} />{t("개인 Slack 설정을 확인하고 있습니다.")}</div> : slackConnected ? <SlackDailyAdvancedSettings connected canManage={false} mode="personal" onNotice={onNotice} /> : <div className="integration-state-message warning"><AlertTriangle size={17} /><div><b>{t("워크스페이스 Slack 연결이 필요합니다")}</b><p>{loadError ? t("연결 상태를 불러오지 못했습니다.") : t("Owner 또는 Admin이 워크스페이스 설정의 자동화 봇에서 Slack을 연결하면 개인 DM 설정을 사용할 수 있습니다.")}</p></div></div>}
    </section>
  </section>;
}

const managementBotSignalMeta: Record<ManagementBotSignal, { label: string; detail: string; tone: "quality" | "urgent" | "done" }> = {
  missing_due_date: { label: "기한 없음", detail: "활성 Project·Task 중 마감일이 비어 있는 항목", tone: "quality" },
  missing_owner: { label: "책임자·담당자 없음", detail: "Project 책임자 또는 Task 담당자가 없는 항목", tone: "quality" },
  overdue: { label: "기한 초과", detail: "마감일이 지났지만 아직 완료되지 않은 항목", tone: "urgent" },
  completed_yesterday: { label: "어제 완료", detail: "어제 완료 상태로 변경된 Project·Task", tone: "done" },
  due_today: { label: "오늘 마감", detail: "오늘까지 완료해야 하는 활성 Project·Task", tone: "urgent" },
};

function managementScheduleSummary(settings: Pick<ManagementBotSettings, "weekdays" | "reportTime" | "channelId" | "channelName" | "signals">) {
  const weekdays = settings.weekdays.join(",") === "1,2,3,4,5" ? t("평일") : settings.weekdays.map(localizedWeekdayLabel).join("·");
  const channel = settings.channelId ? `#${settings.channelName || settings.channelId}` : t("채널 미선택");
  return t("{value1} {value2} · {value3} · {value4}개 점검", { value1: messageValue(weekdays), value2: messageValue(settings.reportTime), value3: messageValue(channel), value4: messageValue(settings.signals.length) });
}

function ManagementSummaryProjectGroup({ group }: { group: ManagementBotProjectGroup }) {
  const overdueTasks = group.tasks.filter((task) => task.isOverdue).length;
  const project = group.project;
  return <section className={`management-summary-project${project?.isOverdue ? " overdue" : ""}${group.projectMatchesSignal ? " matches-signal" : ""}`}>
    <div className="management-summary-project-header">
      {project ? <a href={`/?project=${encodeURIComponent(project.id)}`}>
        <Briefcase size={16} />
        <span><b>{project.title}</b><small>{t("Project")}{project.dueDate ? ` · ${project.dueDate}` : ""}</small></span>
        <ChevronRight size={14} />
      </a> : <div className="management-summary-unassigned"><Briefcase size={16} /><span><b>{t("연결된 Project 없음")}</b><small>{t("{count}개 Task", { count: group.tasks.length })}</small></span></div>}
      <div className="management-summary-delay-status">
        {project?.isOverdue && <strong><AlertTriangle size={14} />{t("Project 기한 초과")}</strong>}
        {overdueTasks > 0 && <strong><AlertTriangle size={14} />{t("기한 초과 Task {count}개", { count: overdueTasks })}</strong>}
      </div>
    </div>
    {group.tasks.length > 0 && <ul className="management-summary-task-list">{group.tasks.map((task) => <li className={task.isOverdue ? "overdue" : ""} key={task.id}>
      <a href={`/?task=${encodeURIComponent(task.id)}`}>
        <span><b>{task.title}</b><small>{t("Task")}{task.dueDate ? ` · ${task.dueDate}` : ""}</small></span>
        {task.isOverdue && <strong><AlertTriangle size={13} />{t("Task 기한 초과")}</strong>}
        <ChevronRight size={14} />
      </a>
    </li>)}</ul>}
  </section>;
}

function WorkspaceManagementSummary() {
  const [date, setDate] = useState(() => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Seoul" }).format(new Date()));
  const [snapshot, setSnapshot] = useState<ManagementBotSnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    void fetch(`/api/workspace-management-bot?mode=summary&date=${encodeURIComponent(date)}`, { signal: controller.signal })
      .then(async (response) => {
        const payload = await response.json() as { snapshot?: ManagementBotSnapshot; error?: string };
        if (!response.ok || !payload.snapshot) throw new Error(apiError(payload, "관리 요약을 불러오지 못했습니다."));
        setSnapshot(payload.snapshot);
      })
      .catch((loadError: unknown) => {
        if (loadError instanceof DOMException && loadError.name === "AbortError") {
          return;
        }
        setError(loadError instanceof Error ? loadError.message : t("관리 요약을 불러오지 못했습니다."));
      })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [attempt, date]);

  function reload(nextDate?: string) {
    setLoading(true);
    setError("");
    if (nextDate !== undefined) setDate(nextDate);
    else setAttempt((current) => current + 1);
  }

  return <section className="workspace-management-summary-pane">
    <header className="workspace-settings-section-header management-summary-header"><div><h3>{t("관리 요약")}</h3><p>{t("정보가 부족하거나 지금 대응해야 할 Project·Task를 봇 설정과 분리해 확인합니다.")}</p></div><div className="management-summary-controls"><label><span>{t("기준일")}</span><input aria-label={t("관리 요약 기준일")} type="date" value={date} onChange={(event) => reload(event.target.value)} /></label><button type="button" onClick={() => reload()} disabled={loading}><RefreshCw className={loading ? "spin" : ""} size={14} />{t("새로고침")}</button></div></header>
    {loading && !snapshot ? <div className="workspace-management-loading"><LoaderCircle className="spin" size={16} />{t("관리 항목을 정리하고 있습니다.")}</div> : error && !snapshot ? <div className="workspace-management-error" role="alert"><AlertTriangle size={17} /><div><b>{t("관리 요약을 불러오지 못했습니다")}</b><p>{error}</p><button type="button" onClick={() => reload()}>{t("다시 시도")}</button></div></div> : snapshot && <div className="management-summary-content">
      <div className="management-summary-total"><span>{snapshot.date} {t("기준")}</span><b>{t("{count}개", { count: snapshot.totalCount })}</b><small>{t("중복 항목은 각 관리 기준에 각각 집계됩니다.")}</small></div>
      {error && <p className="management-summary-refresh-error">{t("최신 정보를 갱신하지 못해 이전 결과를 표시합니다.")}</p>}
      <div className="management-summary-groups">{snapshot.groups.map((group) => { const meta = managementBotSignalMeta[group.signal]; return <details className={meta.tone} key={group.signal}><summary><span><b>{t(meta.label)}</b><small>{t(meta.detail)}</small></span><em>{group.count}</em><ChevronDown size={15} /></summary><div>{group.projects.length ? <div className="management-summary-projects">{group.projects.map((projectGroup) => <ManagementSummaryProjectGroup key={projectGroup.project?.id ?? "unassigned"} group={projectGroup} />)}</div> : <p>{t("해당 항목이 없습니다.")}</p>}</div></details>; })}</div>
    </div>}
  </section>;
}

function WorkspaceManagementBot({ active, canManage, onSummary, onNotice }: { active: boolean; canManage: boolean; onSummary: (status: string, summary: string) => void; onNotice: (message: string) => void }) {
  const { language } = useLanguage();
  const [data, setData] = useState<ManagementBotData | null>(null);
  const [draft, setDraft] = useState<ManagementBotSettings | null>(null);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const loadedRef = useRef(false);
  const { channels, setChannels, loading: channelsLoading, error: channelLoadError, refresh: refreshChannels } = useLiveSlackChannels(active && canManage && Boolean(data?.slackConnected));

  useEffect(() => {
    if (!active || loadedRef.current) return;
    loadedRef.current = true;
    const controller = new AbortController();
    setLoading(true);
    void fetch("/api/workspace-management-bot?mode=settings", { signal: controller.signal })
      .then(async (response) => {
        const payload = await response.json() as ManagementBotData & { error?: string };
        if (!response.ok || !payload.settings) throw new Error(apiError(payload, "관리 봇 정보를 불러오지 못했습니다."));
        setData(payload);
        setDraft(payload.settings);
        setChannels(payload.channels);
        onSummary(!payload.slackConnected ? "연결 필요" : payload.settings.enabled ? payload.settings.lastError ? "전송 확인 필요" : "사용 중" : "중지", managementScheduleSummary(payload.settings));
        setError("");
      })
      .catch((loadError: unknown) => {
        loadedRef.current = false;
        if (loadError instanceof DOMException && loadError.name === "AbortError") return;
        setError(slackErrorMessage(loadError, "관리 봇 정보를 불러오지 못했습니다."));
      })
      .finally(() => setLoading(false));
    return () => controller.abort();
  }, [active, onSummary, setChannels]);

  useEffect(() => {
    if (!data) return;
    onSummary(!data.slackConnected ? "연결 필요" : data.settings.enabled ? data.settings.lastError ? "전송 확인 필요" : "사용 중" : "중지", managementScheduleSummary(data.settings));
  }, [data, language, onSummary]);

  async function save(sendTest = false) {
    if (!draft || saving || !canManage) return;
    setSaving(true);
    setError("");
    try {
      const response = await fetch("/api/workspace-management-bot?mode=settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled: draft.enabled, weekdays: draft.weekdays, reportTime: draft.reportTime, timezone: draft.timezone, channelId: draft.channelId, signals: draft.signals }),
      });
      const next = await response.json() as ManagementBotData & { error?: string; messageCode?: string };
      if (!response.ok || !next.settings) throw new Error(apiError(next, "관리 봇 설정을 저장하지 못했습니다."));
      setData(next);
      setDraft(next.settings);
      setChannels(next.channels);
      onSummary(!next.slackConnected ? "연결 필요" : next.settings.enabled ? next.settings.lastError ? "전송 확인 필요" : "사용 중" : "중지", managementScheduleSummary(next.settings));
      if (sendTest) {
        const testResponse = await fetch("/api/workspace-management-bot", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "test" }) });
        const testData = await testResponse.json() as { sent?: boolean; snapshot?: ManagementBotSnapshot; error?: string; messageCode?: string };
        if (!testResponse.ok || !testData.sent) throw new Error(apiError(testData, "테스트 리포트를 보내지 못했습니다."));
        onNotice(t("선택한 Slack 채널로 관리 리포트 테스트를 보냈습니다."));
      } else {
        onNotice(next.settings.enabled ? t("워크스페이스 관리 봇을 저장했습니다.") : t("워크스페이스 관리 봇을 껐습니다."));
      }
    } catch (saveError) {
      setError(slackErrorMessage(saveError, "관리 봇 설정을 처리하지 못했습니다."));
    } finally {
      setSaving(false);
    }
  }

  function toggleDay(day: number) {
    if (!draft || !canManage) return;
    setDraft({ ...draft, weekdays: draft.weekdays.includes(day) ? draft.weekdays.filter((entry) => entry !== day) : [...draft.weekdays, day].sort() });
  }

  function toggleSignal(signal: ManagementBotSignal) {
    if (!draft || !canManage) return;
    setDraft({ ...draft, signals: draft.signals.includes(signal) ? draft.signals.filter((entry) => entry !== signal) : [...draft.signals, signal] });
  }

  if (!active && !data) return null;
  if (loading) return <section className="workspace-management-pane embedded"><div className="workspace-management-loading"><LoaderCircle className="spin" size={16} />{t("관리 봇 설정을 확인하고 있습니다.")}</div></section>;
  if (!data || !draft) return <section className="workspace-management-pane embedded"><div className="workspace-management-error" role="alert"><AlertTriangle size={17} /><div><b>{t("관리 봇을 불러오지 못했습니다")}</b><p>{error || t("잠시 후 다시 확인해 주세요.")}</p></div></div></section>;
  const weekdayLabels = Array.from({ length: 7 }, (_, day) => localizedWeekdayLabel(day));

  return <section className="workspace-management-pane embedded">
    {data.settings.lastError && <div className="workspace-management-error" role="alert"><AlertTriangle size={17} /><div><b>{t("관리 봇 전송 확인이 필요합니다")}</b><p>{slackErrorMessage(data.settings.lastError)}</p></div></div>}
    {!data.slackConnected && <div className="workspace-settings-note management-slack-note"><Hash size={16} /><div><b>{t("Slack 연결 후 관리 봇을 설정할 수 있습니다")}</b><p>{t("관리 봇은 워크스페이스 공용 채널로 리포트를 보냅니다. 위의 Slack 연결을 먼저 완료해 주세요.")}</p></div></div>}
    {!canManage && <div className="workspace-settings-note"><Eye size={16} /><p>{t("관리 봇 설정은 읽기 전용입니다. Owner 또는 Admin이 발송 항목과 시간을 변경할 수 있습니다.")}</p></div>}

    <div className="management-bot-config compact">
        <div className="management-bot-toggle"><div><b>{t("매일 워크스페이스 관리 리포트")}</b><p>{t("선택한 요일과 시간에 최신 데이터를 다시 계산합니다.")}</p></div><label><input type="checkbox" aria-label={t("워크스페이스 관리 봇 사용")} checked={draft.enabled} disabled={!canManage || !data.slackConnected} onChange={(event) => setDraft({ ...draft, enabled: event.target.checked })} /><span aria-hidden="true" /><span className="sr-only">{t("워크스페이스 관리 봇 사용")}</span></label></div>
        {canManage && data.slackConnected && <SlackChannelSyncStatus loading={channelsLoading} error={channelLoadError} onRefresh={() => void refreshChannels(false)} />}
        <div className="management-schedule-grid core"><label><span>{t("발송 시간")}</span><input type="time" step="900" value={draft.reportTime} disabled={!canManage} onChange={(event) => setDraft({ ...draft, reportTime: event.target.value })} /></label><label className="management-channel-field"><span>{t("Slack 발송 대상")}</span><select aria-label={t("Slack 발송 채널")} value={draft.channelId} disabled={!canManage || !data.slackConnected} onChange={(event) => setDraft({ ...draft, channelId: event.target.value })}><option value="">{t("채널 선택")}</option>{draft.channelId && !channels.some((channel) => channel.id === draft.channelId) && <option value={draft.channelId}>#{draft.channelName || draft.channelId}</option>}{channels.map((channel) => <option value={channel.id} key={channel.id}>{slackChannelOptionLabel(channel)}</option>)}</select></label></div>
        <div className="management-weekdays" aria-label={t("관리 리포트 발송 요일")}>{weekdayLabels.map((label, day) => <button type="button" className={draft.weekdays.includes(day) ? "active" : ""} aria-pressed={draft.weekdays.includes(day)} disabled={!canManage} onClick={() => toggleDay(day)} key={label}>{label}</button>)}</div>
        <details className="bot-advanced-settings"><summary>{t("고급 설정")}<ChevronDown size={14} /></summary><div><label className="management-timezone-field"><span>{t("시간대")}</span><select value={draft.timezone} disabled={!canManage} onChange={(event) => setDraft({ ...draft, timezone: event.target.value })}><option>Asia/Seoul</option><option>America/Los_Angeles</option><option>America/New_York</option><option>Europe/London</option><option>Asia/Tokyo</option></select></label><fieldset className="management-signal-picker"><legend>{t("정리할 정보와 Urgency")}</legend>{(Object.keys(managementBotSignalMeta) as ManagementBotSignal[]).map((signal) => { const meta = managementBotSignalMeta[signal]; return <label key={signal} className={meta.tone}><input type="checkbox" checked={draft.signals.includes(signal)} disabled={!canManage} onChange={() => toggleSignal(signal)} /><span><b>{t(meta.label)}</b><small>{t(meta.detail)}</small></span><span className="sr-only">{t("관리 리포트 정리 항목 선택")}</span></label>; })}</fieldset>{(draft.lastSentAt || draft.lastError) && <p className={`management-bot-last ${draft.lastError ? "error" : ""}`}>{draft.lastError ? t("최근 전송 실패 · {value1}", { value1: messageValue(slackErrorMessage(draft.lastError)) }) : t("최근 전송 · {value1}", { value1: messageValue(formatDateTime(draft.lastSentAt!)) })}</p>}</div></details>
        {error && <p className="management-bot-error" role="alert">{error}</p>}
        {canManage && <div className="management-bot-actions"><button onClick={() => void save(false)} disabled={saving || draft.signals.length === 0 || draft.weekdays.length === 0}>{saving ? t("저장 중") : t("설정 저장")}</button><button onClick={() => void save(true)} disabled={saving || !draft.channelId || draft.signals.length === 0}>{t("테스트 보내기")}</button></div>}
    </div>
  </section>;
}

type WorkspaceBotId = "daily" | "management" | "work" | "automation";

const slackWorkCommands = [
  { label: "생성", commands: ["!업무생성", "@OKRI 만들 일 입력"] },
  { label: "공통", commands: ["!도움말", "!내업무"] },
  { label: "Project", commands: ["!프로젝트생성", "!프로젝트조회", "!프로젝트수정", "!프로젝트상태"] },
  { label: "Task", commands: ["!테스크생성", "!테스크조회", "!테스크수정", "!테스크완료", "!테스크재열기"] },
] as const;

function SlackWorkManagementBot({ connected, needsReauthorization }: { connected: boolean; needsReauthorization: boolean }) {
  if (!connected || needsReauthorization) return <div className="slack-automation-locked"><ListChecks size={16} /><div><b>{t(needsReauthorization ? "Slack 권한 업데이트가 필요합니다" : "Slack 연결 후 업무 생성 관리 봇을 사용할 수 있습니다")}</b><p>{t("DM과 봇이 참여한 채널에서 명령을 처리하려면 메시지 권한을 승인해 주세요.")}</p></div></div>;
  return <div className="slack-work-command-panel">
    <div className="slack-bot-note"><LockKeyhole size={15} /><p>{t("해당 Slack 스레드 내용을 AI 생성 초안에 사용하며, 결과와 입력 화면은 요청자에게만 표시됩니다.")}</p></div>
    <div className="slack-work-command-groups">{slackWorkCommands.map((group) => <section key={group.label}><b>{t(group.label)}</b><div>{group.commands.map((command) => <code key={command}>{command}</code>)}</div></section>)}</div>
    <p className="slack-channel-help">{t("스레드에서 @OKRI와 만들 일을 적거나 !업무생성을 입력하세요. AI 사용량에 포함되며 최종 생성 전 내용을 확인합니다.")}</p>
  </div>;
}

function BotAccordionRow({ id, icon: Icon, title, description, status, summary, expanded, onToggle, children }: { id: WorkspaceBotId; icon: LucideIcon; title: string; description: string; status: string; summary: string; expanded: boolean; onToggle: (id: WorkspaceBotId) => void; children: ReactNode }) {
  const panelId = `workspace-bot-panel-${id}`;
  return <section className={`bot-accordion-row ${expanded ? "open" : ""}`}>
    <button type="button" className="bot-accordion-trigger" aria-expanded={expanded} aria-controls={panelId} onClick={() => onToggle(id)}><span className="bot-accordion-icon"><Icon size={17} /></span><span className="bot-accordion-copy"><b>{title}</b><small>{description}</small><em>{t(summary)}</em></span><span className={`bot-accordion-status ${status === "사용 중" || status === "설정 완료" ? "active" : ""}`}>{t(status)}</span><ChevronDown className="bot-accordion-chevron" size={16} /></button>
    <div id={panelId} className="bot-accordion-panel" hidden={!expanded}>{children}</div>
  </section>;
}

function WorkspaceSlackIntegration({ slack, slackOAuthIssue, loading, loadError, workspaceName, canManageSlack, onSlackChange, onRefresh, onNotice }: { slack: SlackConnectionStatus | null; slackOAuthIssue: SlackOAuthIssue | null; loading: boolean; loadError: boolean; workspaceName: string; canManageSlack: boolean; onSlackChange: (status: SlackConnectionStatus | null) => void; onRefresh: () => void; onNotice: (message: string) => void }) {
  const [disconnectingSlack, setDisconnectingSlack] = useState(false);
  const [botRefreshAttempt, setBotRefreshAttempt] = useState(0);
  const [openBot, setOpenBot] = useState<WorkspaceBotId | null>(() => {
    if (typeof window === "undefined") return null;
    const value = new URLSearchParams(window.location.search).get("bot");
    return value === "daily" || value === "management" || value === "work" || value === "automation" ? value : null;
  });
  const [botSummaries, setBotSummaries] = useState<Record<WorkspaceBotId, { status: string; summary: string }>>({
    daily: { status: "설정 확인", summary: "시간과 대상 멤버를 설정합니다" },
    management: { status: "설정 확인", summary: "시간과 발송 채널을 설정합니다" },
    work: { status: "연결 확인", summary: "Slack에서 Project와 Task를 관리합니다" },
    automation: { status: "설정 확인", summary: "추천 규칙 또는 직접 규칙을 만듭니다" },
  });
  const slackState = loadError && !slack ? "error" : slack?.state ?? "service_unavailable";
  const slackConnected = Boolean(slack?.connected && slackState !== "service_unavailable" && slackState !== "error");
  const connectedSlackName = slack?.connectedTeam?.name || slack?.teamName || "Slack";
  const slackAction = slackState === "connected" ? "연결 완료" : slackState === "setup_required" ? "초기 설정 필요" : slackState === "reauthorization_required" ? "권한 업데이트 필요" : slackState === "workspace_disconnected" ? "연결 필요" : "잠시 사용 불가";
  const displayedBotSummaries = slackConnected ? { ...botSummaries, work: { status: "사용 가능", summary: "Slack 스레드에서 생성 초안을 준비합니다" } } : {
    daily: { status: "연결 필요", summary: "Slack 연결 후 설정할 수 있습니다" },
    management: { status: "연결 필요", summary: "Slack 연결 후 설정할 수 있습니다" },
    work: { status: "연결 필요", summary: "Slack 연결 후 사용할 수 있습니다" },
    automation: { status: "연결 필요", summary: "Slack 연결 후 설정할 수 있습니다" },
  };

  useEffect(() => {
    function syncBotFromHistory() {
      const value = new URLSearchParams(window.location.search).get("bot");
      setOpenBot(value === "daily" || value === "management" || value === "work" || value === "automation" ? value : null);
    }
    window.addEventListener("popstate", syncBotFromHistory);
    return () => window.removeEventListener("popstate", syncBotFromHistory);
  }, []);

  const updateDailySummary = useCallback((status: string, summary: string) => setBotSummaries((current) => ({ ...current, daily: { status, summary } })), []);
  const updateManagementSummary = useCallback((status: string, summary: string) => setBotSummaries((current) => ({ ...current, management: { status, summary } })), []);
  const updateAutomationSummary = useCallback((status: string, summary: string) => setBotSummaries((current) => ({ ...current, automation: { status, summary } })), []);

  function toggleBot(id: WorkspaceBotId) {
    const next = openBot === id ? null : id;
    setOpenBot(next);
    const url = new URL(window.location.href);
    if (next) url.searchParams.set("bot", next); else url.searchParams.delete("bot");
    window.history.pushState(window.history.state, "", url);
  }

  function connectSlack() {
    if (!canManageSlack || !slack || !["workspace_disconnected", "reauthorization_required"].includes(slack.state)) return;
    window.location.href = `/api/slack/auth?returnTo=${encodeURIComponent("/?settings=workspace&tab=integrations")}`;
  }

  function refreshSlackStatus() {
    setBotRefreshAttempt((attempt) => attempt + 1);
    onRefresh();
  }

  async function disconnectSlack() {
    setDisconnectingSlack(true);
    const response = await fetch("/api/slack/disconnect", { method: "POST" });
    setDisconnectingSlack(false);
    if (!response.ok) { onNotice(t("Slack 연결을 해제하지 못했습니다.")); return; }
    onSlackChange(slack ? { ...slack, connected: false, state: "workspace_disconnected", statusMessage: "Owner 또는 Admin이 이 OKRI 워크스페이스에 사용할 Slack을 선택하고 승인할 수 있습니다.", missingScopes: [], connectedTeam: null, teamName: null, teamId: null, botUserId: null, connectedAt: null, updatedAt: null } : null);
    onNotice(t("Slack 연결을 해제했습니다. 자동화 규칙은 보관됩니다."));
  }

  return <section className="workspace-integration-section">
    <header className="workspace-settings-section-header workspace-bot-header">
      <div><h3>{t("자동화 봇")}</h3><p>{t("Slack 연결과 업무 봇을 관리합니다.")}</p></div>
      <button type="button" onClick={refreshSlackStatus} disabled={loading}><RefreshCw className={loading ? "spin" : ""} size={14} />{loading ? t("확인 중") : t("새로고침")}</button>
    </header>
    <div className="workspace-integration-pane">
      <section className="integration-service-card slack-service-card" aria-labelledby="workspace-slack-heading">
      <header><span className="integration-service-icon slack"><Hash size={19} /></span><div><h3 id="workspace-slack-heading">Slack</h3><p>{slackConnected ? connectedSlackName : t("{value1}에 사용할 Slack 워크스페이스", { value1: messageValue(workspaceName) })}</p></div><strong className={`integration-status-badge ${slackState}`}>{loading && !slack ? t("확인 중") : t(slackAction)}</strong></header>
      {slackOAuthIssue && <div className={`integration-state-message ${slackOAuthIssueCopy[slackOAuthIssue].tone}`} role="alert"><AlertTriangle size={17} /><div><b>{t(slackOAuthIssueCopy[slackOAuthIssue].title)}</b><p>{t(slackOAuthIssueCopy[slackOAuthIssue].detail)}</p></div></div>}
      {(!slackConnected || slackState === "reauthorization_required") && <section className="slack-one-button-connect" aria-label={t("Slack 팀 연결")}>
        <div><b>{slackState === "service_unavailable" || slackState === "error" ? t("Slack 연결을 준비하고 있습니다") : slackState === "reauthorization_required" ? t("Slack 권한 업데이트가 필요합니다") : t("팀 Slack을 연결하세요")}</b><p>{slackState === "error" ? t("연결 상태를 불러오지 못했습니다.") : slack?.statusMessage ? t(slack.statusMessage) : t("Slack 사용자와 채널은 승인 후 자동으로 불러옵니다.")}</p></div>
        {loading && !slack ? <span className="integration-inline-loading"><LoaderCircle className="spin" size={14} />{t("확인 중")}</span>
          : slackState === "error" || slackState === "service_unavailable" ? <span className="integration-role-note">{t("잠시 후 사용 가능")}</span>
          : slackState === "workspace_disconnected" && canManageSlack ? <button className="slack-primary-action" onClick={connectSlack}><Hash size={15} />{t("Slack 연결")}</button>
          : slackState === "workspace_disconnected" ? <span className="integration-role-note">{t("Owner 또는 Admin만 연결할 수 있습니다.")}</span>
          : slackState === "reauthorization_required" && canManageSlack ? <button className="slack-primary-action" onClick={connectSlack}>{t("권한 업데이트")}</button>
          : <span className="integration-role-note">{t("관리자가 권한을 업데이트해야 합니다.")}</span>}
      </section>}
      {slackState === "reauthorization_required" && <div className="integration-state-message warning"><AlertTriangle size={17} /><div><b>{t("새 봇 기능 권한이 필요합니다")}</b><p>{t("권한 업데이트 전까지 일부 DM·채널 기능이 작동하지 않을 수 있습니다.")}</p></div></div>}
      {slackConnected && canManageSlack && <details className="slack-advanced-settings"><summary>{t("Slack 연결 관리")}<ChevronDown size={14} /></summary><div><button className="secondary-danger" onClick={() => void disconnectSlack()} disabled={disconnectingSlack}>{disconnectingSlack ? t("연결 해제 중") : t("Slack 연결 해제")}</button></div></details>}
      </section>
      <div className="bot-accordion" aria-label={t("워크스페이스 봇 목록")}>
        <BotAccordionRow id="daily" icon={Bot} title={t("데일리 봇")} description={t("멤버별 데일리 DM과 공유 채널")} status={displayedBotSummaries.daily.status} summary={displayedBotSummaries.daily.summary} expanded={openBot === "daily"} onToggle={toggleBot}><SlackDailySettingsPanel key={`daily-${botRefreshAttempt}`} active={openBot === "daily"} connected={slackConnected} canManage={canManageSlack} teamName={connectedSlackName} onSummary={updateDailySummary} onNotice={onNotice} /></BotAccordionRow>
        <BotAccordionRow id="management" icon={Activity} title={t("관리 봇")} description={t("누락 정보와 긴급 업무 리포트")} status={displayedBotSummaries.management.status} summary={displayedBotSummaries.management.summary} expanded={openBot === "management"} onToggle={toggleBot}><WorkspaceManagementBot key={`management-${botRefreshAttempt}`} active={openBot === "management"} canManage={canManageSlack} onSummary={updateManagementSummary} onNotice={onNotice} /></BotAccordionRow>
        <BotAccordionRow id="work" icon={ListChecks} title={t("업무 생성 관리 봇")} description={t("Slack 스레드에서 Project와 Task 생성")} status={slackState === "reauthorization_required" ? "권한 업데이트 필요" : displayedBotSummaries.work.status} summary={slackState === "reauthorization_required" ? "새 Slack 권한을 승인해 주세요" : displayedBotSummaries.work.summary} expanded={openBot === "work"} onToggle={toggleBot}><SlackWorkManagementBot connected={slackConnected} needsReauthorization={slackState === "reauthorization_required"} /></BotAccordionRow>
        <BotAccordionRow id="automation" icon={Zap} title={t("Task 변동 알림 봇")} description={t("Task의 모든 변경사항 알림")} status={displayedBotSummaries.automation.status} summary={displayedBotSummaries.automation.summary} expanded={openBot === "automation"} onToggle={toggleBot}><SlackAutomationManager key={`automation-${botRefreshAttempt}`} active={openBot === "automation"} connected={slackConnected} canManage={canManageSlack} workspaceName={workspaceName} onSummary={updateAutomationSummary} onNotice={onNotice} /></BotAccordionRow>
      </div>
    </div>
  </section>;
}

type SlackDailyAdminData = {
  connected: boolean; teamName: string | null; needsReauthorization: boolean; setupComplete: boolean;
  delivery?: ReturnType<typeof dailyDeliveryHealth>;
  settings: { enabled: boolean; weekdays: number[]; reminderTime: string; summaryEnabled: boolean; summaryTime: string; workStatuses?: Array<"office" | "remote" | "skip">; timezone: string; installStatus: string; onboardingCompletedAt: string | null; lastSyncedAt: string | null; lastError: string };
  channels: SlackChannelOption[];
  members: Array<{ memberId: string; displayName: string; email: string; linked: boolean; slackDisplayName: string | null; preference: { enabled: boolean; reminderTime: string | null; timezone: string | null }; reminder: { status: string; postAt: number; error: string } | null }>;
  failedPublications: Array<{ id: string; channelId: string; memberName: string; date: string; error: string; attempts: number }>;
};
type SlackDailyPreferenceData = { linked: boolean; enabled: boolean; reminderTime: string; timezone: string; usesWorkspaceTime: boolean; usesWorkspaceTimezone: boolean };

type SlackOnboardingResult = {
  setupComplete: boolean;
  admin: SlackDailyAdminData;
  tests: {
    dm: { status: "sent" | "skipped" | "failed"; memberId: string | null; error?: string };
    channels: Array<{ channelId: string; channelName: string; status: "sent" | "failed"; error?: string }>;
  };
  schedules: Array<{ memberId: string; status: "scheduled" | "failed"; postAt: number | null; error?: string }>;
};

function SlackDailySettingsPanel({ active, connected, canManage, teamName, onSummary, onNotice }: { active: boolean; connected: boolean; canManage: boolean; teamName: string; onSummary: (status: string, summary: string) => void; onNotice: (message: string) => void }) {
  const confirmAction = useAppConfirm();
  const [bulkResult, setBulkResult] = useState<import("@/lib/slack-daily-manual").DailyManualResult | null>(null);
  const [bulkError, setBulkError] = useState("");
  const [bulkSending, setBulkSending] = useState(false);
  const bulkRequestRef = useRef<string | null>(null);
  const bulkLockRef = useRef(false);
  const [admin, setAdmin] = useState<SlackDailyAdminData | null>(null);
  const [savedAdmin, setSavedAdmin] = useState<SlackDailyAdminData | null>(null);
  const [saveError, setSaveError] = useState("");
  const [observedAt, setObservedAt] = useState(Date.now);
  const [editing, setEditing] = useState(false);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [sendingMemberId, setSendingMemberId] = useState<string | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [loadAttempt, setLoadAttempt] = useState(0);
  const [result, setResult] = useState<SlackOnboardingResult | null>(null);
  const loadedRef = useRef(false);
  const shouldLoadChannels = Boolean(admin && (!admin.setupComplete || editing));
  const { channels, setChannels, loading: channelsLoading, error: channelLoadError, refresh: refreshChannels } = useLiveSlackChannels(active && connected && canManage && shouldLoadChannels);

  useEffect(() => {
    if (!active || !connected || !canManage || bulkResult?.status !== "pending" || bulkError) return;
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      void fetch(`/api/slack/daily/settings?runId=${encodeURIComponent(bulkResult.id)}`, { cache: "no-store", signal: controller.signal }).then(async (response) => {
        const data = await response.json() as import("@/lib/slack-daily-manual").DailyManualResult & { error?: string };
        if (!response.ok) throw new Error(apiError(data, "발송 결과를 확인하지 못했습니다."));
        setBulkResult(data);
      }).catch((error: unknown) => {
        if (!controller.signal.aborted) setBulkError(slackErrorMessage(error, "발송 결과를 확인하지 못했습니다."));
      });
    }, 2000);
    return () => { window.clearTimeout(timer); controller.abort(); };
  }, [active, connected, canManage, bulkResult, bulkError]);

  async function sendDailyToAll() {
    if (bulkLockRef.current) return;
    bulkLockRef.current = true;
    try {
      if (!bulkRequestRef.current) {
        const count = admin?.members.filter((member) => member.linked).length ?? 0;
        if (!count || !await confirmAction({ title: t("데일리 전체 발송"), message: t("연결된 멤버 {count}명에게 지금 DM을 보냅니다. 오늘 제출한 멤버와 예약을 끈 멤버도 포함되며, 기존 예약은 유지됩니다.", { count }), confirmLabel: t("전체 보내기") })) return;
        bulkRequestRef.current = crypto.randomUUID();
      }
      setBulkSending(true);
      setBulkError("");
      const response = await fetch("/api/slack/daily/settings", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "send_all_now", requestId: bulkRequestRef.current }) });
      const data = await response.json() as import("@/lib/slack-daily-manual").DailyManualResult & { error?: string };
      if (!response.ok) throw new Error(apiError(data, "발송 결과를 확인하지 못했습니다."));
      setBulkResult(data);
    } catch (error) { setBulkError(slackErrorMessage(error, "발송 결과를 확인하지 못했습니다.")); }
    finally { setBulkSending(false); bulkLockRef.current = false; }
  }

  useEffect(() => {
    if (!active || !connected || !canManage || loadedRef.current) return;
    loadedRef.current = true;
    let mounted = true;
    const controller = new AbortController();
    setLoadError(false);
    void fetch("/api/slack/daily/settings", { cache: "no-store", signal: controller.signal }).then(async (response) => {
      const data = await response.json() as SlackDailyAdminData & { error?: string; manualRun?: import("@/lib/slack-daily-manual").DailyManualResult | null };
      if (!response.ok) throw new Error(apiError(data, "Slack 설정을 불러오지 못했습니다."));
      return data;
    }).then((nextAdmin) => {
      if (!mounted) return;
      setObservedAt(Date.now());
      setAdmin(nextAdmin);
      setSavedAdmin(nextAdmin);
      if (nextAdmin.manualRun) {
        setBulkResult(nextAdmin.manualRun);
        bulkRequestRef.current = nextAdmin.manualRun.id;
      }
      setChannels(nextAdmin.channels);
      const targetCount = nextAdmin.members.filter((member) => member.linked && member.preference.enabled).length;
      const days = nextAdmin.settings.weekdays.join(",") === "1,2,3,4,5" ? "평일" : nextAdmin.settings.weekdays.map((day) => ["일", "월", "화", "수", "목", "금", "토"][day]).join("·");
      onSummary(dailyDeliveryLabel((nextAdmin.delivery ?? dailyDeliveryHealth(nextAdmin.settings, nextAdmin.members)).status), t("{value1} {value2} · {value3}명 · {value4}", { value1: messageValue(days), value2: messageValue(nextAdmin.settings.reminderTime), value3: messageValue(targetCount), value4: messageValue(nextAdmin.channels.length ? nextAdmin.channels.map((channel) => `#${channel.name}`).join(", ") : "DM 전용") }));
      setLoadError(false);
    }).catch((error: unknown) => {
      if (error instanceof DOMException && error.name === "AbortError") return;
      if (mounted) { setLoadError(true); onSummary("불러오기 실패", "설정을 다시 확인해 주세요"); }
    });
    return () => {
      mounted = false;
      controller.abort();
      loadedRef.current = false;
    };
  }, [active, connected, canManage, loadAttempt, onSummary, setChannels]);

  useEffect(() => {
    if (!active || editing || admin !== savedAdmin || admin?.delivery?.status !== "pending") return;
    const timer = window.setTimeout(() => { loadedRef.current = false; setLoadAttempt((attempt) => attempt + 1); }, 3000);
    return () => window.clearTimeout(timer);
  }, [active, admin, editing, savedAdmin]);

  useEffect(() => {
    if (connected || !active) return;
    onSummary("연결 필요", "Slack 연결 후 설정할 수 있습니다");
  }, [active, connected, onSummary]);

  async function completeSetup() {
    if (!admin) return;
    const memberIds = admin.members.filter((member) => member.linked && member.preference.enabled).map((member) => member.memberId);
    if (!memberIds.length) { onNotice(t("알림을 받을 멤버를 한 명 이상 선택해 주세요.")); return; }
    setBusy(true);
    setSaveError("");
    try {
      const response = await fetch("/api/slack/onboarding", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          weekdays: admin.settings.weekdays,
          reminderTime: admin.settings.reminderTime,
          summaryEnabled: admin.settings.summaryEnabled ?? true,
          summaryTime: admin.settings.summaryTime ?? "12:00",
          workStatuses: admin.settings.workStatuses ?? ["office", "remote", "skip"],
          timezone: admin.settings.timezone,
          memberIds,
          channelIds: admin.channels.map((channel) => channel.id),
        }),
      });
      const data = await response.json() as SlackOnboardingResult & { error?: string };
      if (!response.ok || !data.admin) throw new Error(apiError(data, "데일리 설정을 저장하지 못했습니다."));
      setAdmin(data.admin);
      setSavedAdmin(data.admin);
      setResult(data);
      setEditing(false);
      const targetCount = data.admin.members.filter((member) => member.linked && member.preference.enabled).length;
      const days = data.admin.settings.weekdays.join(",") === "1,2,3,4,5" ? "평일" : data.admin.settings.weekdays.map((day) => ["일", "월", "화", "수", "목", "금", "토"][day]).join("·");
      onSummary(dailyDeliveryLabel((data.admin.delivery ?? dailyDeliveryHealth(data.admin.settings, data.admin.members)).status), t("{value1} {value2} · {value3}명 · {value4}", { value1: messageValue(days), value2: messageValue(data.admin.settings.reminderTime), value3: messageValue(targetCount), value4: messageValue(data.admin.channels.length ? data.admin.channels.map((channel) => `#${channel.name}`).join(", ") : "DM 전용") }));
      const failed = data.schedules.some((entry) => entry.status === "failed") || data.tests.dm.status === "failed" || data.tests.channels.some((entry) => entry.status === "failed");
      onNotice(failed ? t("설정은 저장했지만 발송 예약을 확인하지 못했습니다. 예약 복구를 눌러 주세요.") : t("데일리 설정을 저장했습니다."));
    } catch (error) {
      setSaveError(slackErrorMessage(error, "데일리 설정을 저장하지 못했습니다."));
      onNotice(slackErrorMessage(error, "데일리 설정을 저장하지 못했습니다."));
    } finally {
      setBusy(false);
    }
  }

  async function retrySetupResult(kind: "dm" | "channel" | "schedule", id: string | null) {
    if (!result) return;
    setBusy(true);
    try {
      const payload = kind === "dm" ? { action: "test_dm", memberId: id }
        : kind === "channel" ? { action: "test_channel", channelId: id }
          : { action: "resync" };
      const response = await fetch("/api/slack/daily/settings", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
      const data = await response.json() as SlackDailyAdminData & { error?: string };
      if (!response.ok) throw new Error(apiError(data, "Slack 테스트를 다시 실행하지 못했습니다."));
      if (kind === "dm") setResult({ ...result, tests: { ...result.tests, dm: { ...result.tests.dm, status: "sent", error: undefined } } });
      if (kind === "channel") setResult({ ...result, tests: { ...result.tests, channels: result.tests.channels.map((entry) => entry.channelId === id ? { ...entry, status: "sent", error: undefined } : entry) } });
      if (kind === "schedule" && data.settings) {
        setAdmin(data);
        setResult({ ...result, schedules: result.schedules.map((entry) => {
          const reminder = data.members.find((member) => member.memberId === entry.memberId)?.reminder;
          return reminder?.status === "scheduled" && reminder.postAt > Date.now() / 1000 ? { ...entry, postAt: reminder.postAt, status: "scheduled", error: undefined } : entry;
        }) });
      }
      onNotice(t("실패한 Slack 항목을 다시 확인했습니다."));
    } catch (error) {
      onNotice(slackErrorMessage(error, "Slack 테스트를 다시 실행하지 못했습니다."));
    } finally {
      setBusy(false);
    }
  }

  async function sendDailyNow(member: SlackDailyAdminData["members"][number]) {
    setSendingMemberId(member.memberId);
    try {
      const response = await fetch("/api/slack/daily/settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "send_now", memberId: member.memberId }),
      });
      const data = await response.json() as { sent?: boolean; error?: string };
      if (!response.ok || !data.sent) throw new Error(apiError(data, "데일리 봇 DM을 보내지 못했습니다."));
      onNotice(t("{value1}님에게 데일리 봇 DM을 보냈습니다.", { value1: messageValue(member.displayName) }));
    } catch (error) {
      onNotice(slackErrorMessage(error, "데일리 봇 DM을 보내지 못했습니다."));
    } finally {
      setSendingMemberId(null);
    }
  }

  async function repairReservations() {
    setBusy(true);
    try {
      const response = await fetch("/api/slack/daily/settings", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "repair" }) });
      const data = await response.json() as SlackDailyAdminData & { error?: string };
      if (!response.ok || !data.settings) throw new Error(apiError(data, "예약을 복구하지 못했습니다."));
      setAdmin(data);
      loadedRef.current = false;
      setLoadAttempt((attempt) => attempt + 1);
      onNotice(data.delivery?.status === "ready" ? t("설정된 시간의 발송 예약을 복구했습니다.") : t("예약 상태를 확인했습니다. 아직 예약되지 않은 멤버가 있습니다."));
    } catch (error) { onNotice(slackErrorMessage(error, "예약을 복구하지 못했습니다.")); }
    finally { setBusy(false); }
  }

  if (!active && !admin) return null;
  if (!connected) return <div className="slack-daily-locked"><LockKeyhole size={18} /><div><b>{t("Slack 연결 후 데일리 봇을 설정할 수 있습니다")}</b><p>{t("기존 설정은 그대로 유지되며 Slack 연결을 완료하면 다시 사용할 수 있습니다.")}</p></div></div>;
  if (!canManage) return <section className="slack-connected-summary"><div><CheckCircle2 size={18} /><p><b>{t("OKRI 연결 완료")}</b><span>{t("연결된 Slack 워크스페이스:")}{teamName}</span><span>{t("관리자가 설정한 시간에 내 Slack DM으로 데일리를 받을 수 있습니다.")}</span></p></div></section>;
  if (loadError) return <section className="integration-state-message error"><AlertTriangle size={17} /><div><b>{t("Slack 설정을 불러오지 못했습니다")}</b><p>{t("연결은 유지됩니다. 잠시 후 다시 확인해 주세요.")}</p></div><button onClick={() => { loadedRef.current = false; setLoadError(false); setLoadAttempt((attempt) => attempt + 1); }}>{t("다시 불러오기")}</button></section>;
  if (!admin) return <div className="slack-daily-loading"><LoaderCircle className="spin" size={15} />{t("데일리 설정 확인 중")}</div>;

  const showSetup = !admin.setupComplete || editing;
  const settingsValue = (value: SlackDailyAdminData | null) => value ? JSON.stringify({ settings: [value.settings.reminderTime, value.settings.timezone, value.settings.weekdays, value.settings.summaryEnabled ?? true, value.settings.summaryTime ?? "12:00", value.settings.workStatuses ?? ["office", "remote", "skip"]], members: value.members.filter((member) => member.linked && member.preference.enabled).map((member) => member.memberId).sort(), channels: value.channels.map((channel) => channel.id).sort() }) : "";
  const dirty = settingsValue(admin) !== settingsValue(savedAdmin);
  const targetMembers = admin.members.filter((member) => member.linked && member.preference.enabled);
  const linkedMembers = admin.members.filter((member) => member.linked);
  const delivery = admin.delivery ?? dailyDeliveryHealth(admin.settings, admin.members, observedAt);
  const nextReminder = targetMembers.flatMap((member) => member.reminder?.status === "scheduled" && member.reminder.postAt > observedAt / 1000 ? [member.reminder.postAt] : []).sort((a, b) => a - b)[0];
  const weekdayLabels = ["일", "월", "화", "수", "목", "금", "토"];
  const workStatusLabels = { office: "출근", remote: "재택", skip: "스킵" } as const;
  const workStatuses = admin.settings.workStatuses ?? ["office", "remote", "skip"];

  return <div className="slack-one-button-flow">
    <SlackMemberConnections onChanged={() => { void fetch("/api/slack/daily/settings", { cache: "no-store" }).then(async (response) => { if (!response.ok) throw new Error(); return response.json() as Promise<SlackDailyAdminData>; }).then((latest) => setAdmin((current) => current ? { ...current, members: latest.members.map((member) => ({ ...member, preference: current.members.find((entry) => entry.memberId === member.memberId)?.preference ?? member.preference })) } : latest)).catch(() => onNotice(t("계정 연결은 저장했지만 멤버 상태를 갱신하지 못했습니다. 다시 열어 확인해 주세요."))); }} />
    {delivery.status === "failed" && <section className="integration-state-message error" role="alert"><AlertTriangle size={17} /><div><b>{t("데일리 발송 예약에 문제가 있습니다")}</b><p>{t("{total}명 중 {scheduled}명 예약됨 · {failed}명 예약 확인 필요", { total: delivery.targetCount, scheduled: delivery.scheduledCount, failed: delivery.failedCount })}</p><p>{slackErrorMessage(admin.settings.lastError, "다음 발송 예약을 확인하지 못했습니다. 예약 복구를 눌러 다시 확인해 주세요.")}</p></div><button type="button" disabled={busy} onClick={() => void repairReservations()}>{t("예약 복구")}</button></section>}
    {showSetup ? <section className="slack-onboarding-card" aria-labelledby="slack-onboarding-title">
      <header><div><h4 id="slack-onboarding-title">{t("데일리 설정")}</h4><p>{t("발송 시간, 멤버와 공유 채널을 정합니다.")}</p></div>{(admin.setupComplete || dirty) && <button type="button" disabled={busy} onClick={() => { if (savedAdmin) setAdmin(savedAdmin); setSaveError(""); setEditing(false); }}>{t("취소")}</button>}</header>
      <div className="slack-save-status" role="status">{busy ? t("저장 중") : dirty ? t("저장하지 않은 변경사항") : admin.setupComplete ? t("저장됨") : t("설정 필요")}</div>
      {saveError && <p className="slack-save-error" role="alert">{saveError}</p>}
      <div className="slack-onboarding-grid single">
        <label><span>{t("발송 시간")}</span><input disabled={busy} aria-label={t("Slack 데일리 발송 시간")} type="time" value={admin.settings.reminderTime} onChange={(event) => setAdmin({ ...admin, settings: { ...admin.settings, reminderTime: event.target.value } })} /></label>
      </div>
      <fieldset className="slack-onboarding-weekdays"><legend>{t("근무 선택지")}</legend><div>{Object.entries(workStatusLabels).map(([status, label]) => <label key={status}><input disabled={busy} type="checkbox" checked={workStatuses.includes(status as keyof typeof workStatusLabels)} onChange={(event) => setAdmin({ ...admin, settings: { ...admin.settings, workStatuses: event.target.checked ? [...workStatuses, status as keyof typeof workStatusLabels] : workStatuses.filter((entry) => entry !== status) } })} /><span>{t(label)}</span></label>)}</div></fieldset>
      <div className="daily-digest-settings">
        <label className="daily-digest-toggle"><input type="checkbox" disabled={busy} checked={admin.settings.summaryEnabled ?? true} onChange={(event) => setAdmin({ ...admin, settings: { ...admin.settings, summaryEnabled: event.target.checked } })} /><span>{t("팀원·KR별 Task 요약 공유")}</span></label>
        {(admin.settings.summaryEnabled ?? true) && <div className="slack-onboarding-grid single"><label><span>{t("요약 공유 마감 시간")}</span><input type="time" disabled={busy} required aria-label={t("요약 공유 마감 시간")} value={admin.settings.summaryTime ?? "12:00"} onChange={(event) => setAdmin({ ...admin, settings: { ...admin.settings, summaryTime: event.target.value } })} /></label></div>}
        <p>{t("모두 공유하면 즉시, 미공유 인원이 있으면 마감 시간에 공유합니다.")}</p>
        {!admin.channels.length && <p className="daily-digest-no-channel">{t("요약을 받으려면 공유 채널을 선택해 주세요.")}</p>}
      </div>
      <fieldset className="slack-onboarding-weekdays"><legend>{t("발송 요일")}</legend><div>{weekdayLabels.map((label, day) => <label key={label}><input disabled={busy} type="checkbox" checked={admin.settings.weekdays.includes(day)} onChange={(event) => setAdmin({ ...admin, settings: { ...admin.settings, weekdays: event.target.checked ? [...admin.settings.weekdays, day].sort() : admin.settings.weekdays.filter((entry) => entry !== day) } })} /><span>{label}</span></label>)}</div></fieldset>
      <fieldset className="slack-onboarding-members"><legend>{t("알림 받을 멤버")}</legend><div className="bot-target-shortcut"><p>{t("이메일이 같은 Slack 계정을 연결합니다.")}</p><button type="button" disabled={busy} onClick={() => setAdmin({ ...admin, members: admin.members.map((member) => member.linked ? { ...member, preference: { ...member.preference, enabled: true } } : member) })}>{t("연결 멤버 전체 선택")}</button></div><div>{admin.members.map((member) => <label key={member.memberId} className={member.linked ? "" : "disabled"}><input aria-label={t("{value1} Slack 알림 대상", { value1: messageValue(member.displayName) })} type="checkbox" disabled={busy || !member.linked} checked={member.linked && member.preference.enabled} onChange={(event) => setAdmin({ ...admin, members: admin.members.map((entry) => entry.memberId === member.memberId ? { ...entry, preference: { ...entry.preference, enabled: event.target.checked } } : entry) })} /><span><b>{member.displayName}</b><small>{member.linked ? t("Slack 연결됨") : t("Slack 계정 미연결")}</small></span></label>)}</div></fieldset>
      <fieldset className="slack-onboarding-channels"><legend>{t("공유 채널")}</legend><SlackChannelSyncStatus loading={channelsLoading} error={channelLoadError} onRefresh={() => void refreshChannels(false)} /><label className="slack-no-channel"><input disabled={busy} aria-label={t("채널 공유 안 함")} type="radio" name="slack-channel-sharing" checked={admin.channels.length === 0} onChange={() => setAdmin({ ...admin, channels: [] })} /><span><b>{t("공유 안 함")}</b><small>{t("개인 DM만 발송")}</small></span></label>{channels.map((channel) => <label key={channel.id}><input disabled={busy} aria-label={t("{value1} Slack 공유 채널", { value1: messageValue(channel.name) })} type="checkbox" checked={admin.channels.some((entry) => entry.id === channel.id)} onChange={(event) => setAdmin({ ...admin, channels: event.target.checked ? [...admin.channels, channel] : admin.channels.filter((entry) => entry.id !== channel.id) })} /><span><b>#{channel.name}</b><small>{slackChannelKindLabel(channel)}</small></span></label>)}</fieldset>
      <details className="bot-advanced-settings"><summary>{t("고급 설정")}<ChevronDown size={14} /></summary><div><label className="daily-timezone-field"><span>{t("시간대")}</span><select disabled={busy} aria-label={t("Slack 데일리 시간대")} value={admin.settings.timezone} onChange={(event) => setAdmin({ ...admin, settings: { ...admin.settings, timezone: event.target.value } })}><option>Asia/Seoul</option><option>America/Los_Angeles</option><option>America/New_York</option><option>Europe/London</option><option>Asia/Tokyo</option></select></label></div></details><footer><button className="slack-primary-action" type="button" disabled={busy || (!dirty && admin.setupComplete) || admin.settings.weekdays.length === 0 || !targetMembers.length || !workStatuses.some((status) => status !== "skip")} aria-busy={busy} onClick={() => void completeSetup()}>{busy ? <LoaderCircle className="spin" size={14} /> : <CheckCircle2 size={14} />}{busy ? t("저장 중") : t("변경사항 저장")}</button></footer>
    </section> : <section className="slack-connected-summary">
      <div className="slack-connected-title">{delivery.status === "ready" ? <CheckCircle2 size={19} /> : <span><AlertTriangle size={19} /></span>}<p><b>{t("데일리 봇")}{dailyDeliveryLabel(delivery.status)}</b><span>{teamName}</span></p><button type="button" disabled={busy} onClick={() => { setSavedAdmin(admin); setSaveError(""); setEditing(true); }}>{t("설정")}</button></div>
      <dl><div><dt>{t("대상")}</dt><dd>{t("{count}명", { count: targetMembers.length })}</dd></div><div><dt>{t("다음 발송")}</dt><dd>{nextReminder ? new Date(nextReminder * 1000).toLocaleString(getClientLocale(), { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" }) : t("예약 확인 필요")}</dd></div><div><dt>{t("공유 채널")}</dt><dd>{admin.channels.length ? admin.channels.map((channel) => `#${channel.name}`).join(", ") : t("공유 안 함")}</dd></div></dl>
      <div className="daily-digest-summary"><b>{t("데일리 팀 요약")}</b><span>{!(admin.settings.summaryEnabled ?? true) ? t("꺼짐") : !admin.channels.length ? t("공유 채널 미지정") : t("전원 공유 시 즉시 · 늦어도 {time}", { time: admin.settings.summaryTime ?? "12:00" })}</span></div>
      <section className="slack-manual-send" aria-labelledby="slack-manual-send-title">
        <header><div><b id="slack-manual-send-title">{t("즉시 발송")}</b><small>{t("멤버에게 데일리 DM을 바로 보냅니다.")}</small></div><button type="button" disabled={busy || sendingMemberId !== null || bulkSending || bulkResult?.status === "pending" || !linkedMembers.length || Boolean(bulkError)} onClick={() => { if (bulkResult?.status === "complete") bulkRequestRef.current = null; void sendDailyToAll(); }}><Send size={14} />{bulkSending || bulkResult?.status === "pending" ? t("발송 중") : t("전체 보내기")}</button></header>
        {bulkResult && <p className="slack-bulk-result" role="status">{bulkResult.createdAt && <>{t("최근 수동 발송")} · {formatSlackAutomationTime(bulkResult.createdAt)}<br /></>}{t("전체 {total}명 · 성공 {sent} · 실패 {failed} · 확인 필요 {uncertain} · 대기 {pending}", { total: bulkResult.total, sent: bulkResult.sent, failed: bulkResult.failed, uncertain: bulkResult.uncertain, pending: bulkResult.pending })}</p>}
        {bulkResult?.uncertain ? <p className="slack-save-error">{t("일부 발송 결과를 확인하지 못했습니다. 중복 발송을 피하려면 해당 멤버의 Slack을 먼저 확인해 주세요.")}</p> : null}
        {bulkError && <div className="slack-bulk-error" role="alert"><span>{bulkError}</span><button type="button" disabled={bulkSending} onClick={() => void sendDailyToAll()}><RefreshCw size={13} />{t("발송 결과 다시 확인")}</button></div>}
        {linkedMembers.length ? <div className="slack-member-links">{linkedMembers.map((member) => {
          const receipt = bulkResult?.members.find((entry) => entry.memberId === member.memberId);
          const status = receipt ? receipt.status === "sent" ? t("전송 성공") : ["failed", "cancelled"].includes(receipt.status) ? t("전송 실패") : receipt.status === "uncertain" ? t("확인 필요") : t("발송 처리 중") : member.preference.enabled ? t("예약 대상") : t("수동 발송만");
          return <div key={member.memberId}><span className="linked" /><p><b>{member.displayName}</b><small>{status}</small>{receipt?.error && <small className="slack-save-error">{slackErrorMessage(receipt.error)}</small>}</p><button type="button" disabled={busy || sendingMemberId !== null || bulkSending || bulkResult?.status === "pending"} onClick={() => void sendDailyNow(member)}>{sendingMemberId === member.memberId ? <><LoaderCircle className="spin" size={13} />{t("발송 중")}</> : t("지금 보내기")}</button></div>;
        })}</div> : <p className="slack-manual-send-empty">{t("Slack에 연결된 멤버가 없습니다.")}</p>}
      </section>
      {result && <div className="slack-test-results" role="status"><p className={result.tests.dm.status}><span>{result.tests.dm.status === "sent" ? t("설치자 테스트 DM 성공") : result.tests.dm.status === "skipped" ? t("설치자 DM 테스트 생략") : t("테스트 DM 실패 · {value1}", { value1: messageValue(slackErrorMessage(result.tests.dm.error)) })}</span>{result.tests.dm.status === "failed" && <button disabled={busy} onClick={() => void retrySetupResult("dm", result.tests.dm.memberId)}>{t("재시도")}</button>}</p>{result.tests.channels.map((channel) => <p key={channel.channelId} className={channel.status}><span>{channel.status === "sent" ? t("#{value1} 테스트 성공", { value1: messageValue(channel.channelName) }) : t("#{value1} 실패 · {value2}", { value1: messageValue(channel.channelName), value2: messageValue(slackErrorMessage(channel.error)) })}</span>{channel.status === "failed" && <button disabled={busy} onClick={() => void retrySetupResult("channel", channel.channelId)}>{t("재시도")}</button>}</p>)}{result.schedules.filter((entry) => entry.status === "failed").map((entry) => <p key={entry.memberId} className="failed"><span>{t("예약 실패 · {name}", { name: admin.members.find((member) => member.memberId === entry.memberId)?.displayName || t("미지정") })}</span><button disabled={busy} onClick={() => void retrySetupResult("schedule", null)}>{t("재시도")}</button></p>)}</div>}
    </section>}
    {admin.setupComplete && <details className="slack-advanced-settings" onToggle={(event) => setAdvancedOpen(event.currentTarget.open)}><summary>{t("멤버 연결·발송 관리")}<ChevronDown size={14} /></summary>{advancedOpen && <SlackDailyAdvancedSettings connected canManage mode="workspace" onNotice={onNotice} />}</details>}
  </div>;
}

function SlackDailyAdvancedSettings({ connected, canManage, mode = "workspace", onNotice }: { connected: boolean; canManage: boolean; mode?: "personal" | "workspace"; onNotice: (message: string) => void }) {
  const confirmAction = useAppConfirm();
  const [preference, setPreference] = useState<SlackDailyPreferenceData | null>(null);
  const [savedPreference, setSavedPreference] = useState<SlackDailyPreferenceData | null>(null);
  const [preferenceError, setPreferenceError] = useState("");
  const [admin, setAdmin] = useState<SlackDailyAdminData | null>(null);
  const [busy, setBusy] = useState(false);
  const [loadError, setLoadError] = useState(false);
  const [loadAttempt, setLoadAttempt] = useState(0);
  const { channels: availableChannels, loading: channelsLoading, error: channelLoadError, refresh: refreshChannels } = useLiveSlackChannels(connected && canManage && mode === "workspace");
  useEffect(() => {
    if (!connected) return;
    let active = true;
    const preferenceRequest = mode === "personal" ? fetch("/api/slack/daily/preferences").then(async (response) => {
      if (!response.ok) throw new Error("preference load failed");
      return response.json() as Promise<SlackDailyPreferenceData>;
    }) : Promise.resolve(null);
    const adminRequest = mode === "workspace" && canManage
      ? fetch("/api/slack/daily/settings", { cache: "no-store" }).then(async (response) => { if (!response.ok) throw new Error("settings load failed"); return response.json() as Promise<SlackDailyAdminData>; })
      : Promise.resolve(null);
    void Promise.all([preferenceRequest, adminRequest]).then(([nextPreference, nextAdmin]) => {
      if (!active) return;
      setLoadError(false);
      if (nextPreference) { setPreference(nextPreference); setSavedPreference(nextPreference); }
      if (nextAdmin) setAdmin(nextAdmin);
    }).catch(() => { if (active) setLoadError(true); });
    return () => { active = false; };
  }, [connected, canManage, loadAttempt, mode]);

  async function savePreference(patch: Partial<Pick<SlackDailyPreferenceData, "enabled" | "reminderTime" | "timezone">>) {
    setBusy(true);
    setPreferenceError("");
    try {
      const response = await fetch("/api/slack/daily/preferences", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(patch) });
      const data = await response.json() as SlackDailyPreferenceData & { error?: string }; if (!response.ok) throw new Error(apiError(data, "개인 알림을 저장하지 못했습니다."));
      setPreference(data); setSavedPreference(data); onNotice(t("개인 Slack 데일리 알림을 저장했습니다."));
    } catch (error) { setPreferenceError(slackErrorMessage(error, "개인 알림을 저장하지 못했습니다.")); onNotice(slackErrorMessage(error, "개인 알림을 저장하지 못했습니다.")); } finally { setBusy(false); }
  }
  async function patchAdmin(payload: Record<string, unknown>, notice: string) {
    setBusy(true);
    try {
      const response = await fetch("/api/slack/daily/settings", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
      const data = await response.json() as SlackDailyAdminData & { error?: string }; if (!response.ok) throw new Error(apiError(data, "Slack 데일리 설정을 저장하지 못했습니다."));
      if (data.settings) setAdmin(data); onNotice(notice);
    } catch (error) { onNotice(slackErrorMessage(error, "Slack 데일리 설정을 저장하지 못했습니다.")); } finally { setBusy(false); }
  }
  async function republishLatest(member: SlackDailyAdminData["members"][number]) {
    if (!admin?.channels.length) { onNotice(t("데일리 공유 채널을 먼저 선택해 주세요.")); return; }
    const channels = admin.channels.map((channel) => `#${channel.name}`).join(", ");
    if (!await confirmAction({
      title: t("최신 데일리 공유"),
      message: t("{name}님의 마지막 제출을 {channels}에 공유합니다. 이미 공유된 카드가 있으면 최신 내용으로 바꾸고, 삭제됐다면 새로 게시합니다.", { name: messageValue(member.displayName), channels: messageValue(channels) }),
      confirmLabel: t("지금 공유"),
    })) return;
    await patchAdmin({ action: "republish_latest", memberId: member.memberId, requestId: crypto.randomUUID() },
      t("{name}님의 최신 데일리를 공유했습니다.", { name: messageValue(member.displayName) }));
  }
  if (!connected) return null;
  if (loadError) return <section className="integration-state-message error"><AlertTriangle size={17} /><div><b>{t("Slack 데일리 설정을 불러오지 못했습니다")}</b><p>{t("연결은 유지됩니다. 잠시 후 다시 불러와 주세요.")}</p></div><button onClick={() => { setLoadError(false); setPreference(null); setAdmin(null); setLoadAttempt((attempt) => attempt + 1); }}>{t("다시 불러오기")}</button></section>;
  return <div className="slack-setup-flow">
    {mode === "workspace" && <section className="integration-step" aria-labelledby="slack-step-members">
      <span className="integration-step-number">2</span><div className="integration-step-copy"><h4 id="slack-step-members">{t("사용자 이메일 연결 상태")}</h4><p>{t("OKRI와 Slack 이메일이 같으면 자동으로 연결됩니다.")}</p></div>
      <div className="integration-step-body">
        {canManage && !admin ? <div className="slack-daily-loading"><LoaderCircle className="spin" size={14} />{t("사용자 연결 상태 확인 중")}</div> : canManage && admin ? <><div className="integration-step-summary"><b>{t("{total}명 중 {linked}명 연결", { total: admin.members.length, linked: admin.members.filter((member) => member.linked).length })}</b><span>{t("미연결 사용자는 Slack의 `/okri daily`에서 일회용 연결 링크를 받을 수 있습니다.")}</span></div><div className="slack-member-links">{admin.members.map((member) => <div key={member.memberId}><span className={member.linked ? "linked" : "unlinked"} /><p><b>{member.displayName}</b><small>{member.linked ? t("Slack 연결됨") : t("Slack 미연결")}{member.reminder ? ` · ${slackReminderLabel(member.reminder.status)}` : ""}</small></p></div>)}</div></> : <div className="integration-connected-note"><CheckCircle2 size={15} />{t("사용자별 Slack 연결 상태는 Owner 또는 Admin이 확인합니다.")}</div>}
      </div>
    </section>}

    {mode === "personal" && <><section className="integration-step" aria-labelledby="slack-personal-link">
      <span className="integration-step-number">1</span><div className="integration-step-copy"><h4 id="slack-personal-link">{t("내 Slack 계정")}</h4><p>{t("워크스페이스 멤버와 Slack 사용자를 연결합니다.")}</p></div>
      <div className="integration-step-body">{preference ? <div className={`integration-personal-link ${preference.linked ? "linked" : "unlinked"}`}><span>{preference.linked ? <CheckCircle2 size={16} /> : <AlertTriangle size={16} />}</span><p><b>{preference.linked ? t("내 Slack 계정이 연결되었습니다") : t("내 Slack 계정 연결이 필요합니다")}</b><small>{preference.linked ? t("개인 DM 알림을 설정할 수 있습니다.") : t("Slack에서 `/okri daily`를 입력해 일회용 연결 링크를 받아 주세요.")}</small></p></div> : <div className="slack-daily-loading"><LoaderCircle className="spin" size={14} />{t("개인 연결 상태 확인 중")}</div>}</div>
    </section><section className="integration-step" aria-labelledby="slack-step-preference">
      <span className="integration-step-number">3</span><div className="integration-step-copy"><h4 id="slack-step-preference">{t("개인 데일리 알림 시간")}</h4><p>{t("평일 아침에 오늘 할 Task를 고르는 DM을 받습니다.")}</p></div>
      <div className="integration-step-body">{preference ? <div className="slack-personal-preference"><label><input type="checkbox" checked={preference.enabled} disabled={busy || !preference.linked} onChange={(event) => setPreference({ ...preference, enabled: event.target.checked })} /><span>{t("내 Slack DM 알림 사용")}</span></label><label><span>{t("시간")}</span><input aria-label={t("개인 데일리 알림 시간")} type="time" value={preference.reminderTime} disabled={busy || !preference.linked} onChange={(event) => setPreference({ ...preference, reminderTime: event.target.value })} /></label><label><span>{t("시간대")}</span><select aria-label={t("개인 데일리 알림 시간대")} value={preference.timezone} disabled={busy || !preference.linked} onChange={(event) => setPreference({ ...preference, timezone: event.target.value })}><option>Asia/Seoul</option><option>America/Los_Angeles</option><option>America/New_York</option><option>Europe/London</option><option>Asia/Tokyo</option></select></label><div className="slack-save-actions"><span className="slack-save-status" role="status">{busy ? t("저장 중") : JSON.stringify(preference) !== JSON.stringify(savedPreference) ? t("저장하지 않은 변경사항") : t("저장됨")}</span><button type="button" className="cancel" disabled={busy || JSON.stringify(preference) === JSON.stringify(savedPreference)} onClick={() => { setPreference(savedPreference); setPreferenceError(""); }}>{t("취소")}</button><button type="button" className="primary-action" aria-busy={busy} disabled={busy || !preference.linked || JSON.stringify(preference) === JSON.stringify(savedPreference)} onClick={() => void savePreference({ enabled: preference.enabled, reminderTime: preference.reminderTime, timezone: preference.timezone })}>{busy ? t("저장 중") : t("변경사항 저장")}</button></div>{preferenceError && <p className="slack-save-error" role="alert">{preferenceError}</p>}{!preference.linked && <p>{t("Slack 사용자 연결을 완료하면 알림 설정이 활성화됩니다.")}</p>}</div> : <div className="slack-daily-loading"><LoaderCircle className="spin" size={14} />{t("개인 알림 설정 확인 중")}</div>}</div>
    </section></>}

    {mode === "workspace" && <><section className="integration-step" aria-labelledby="slack-step-channel">
      <span className="integration-step-number">4</span><div className="integration-step-copy"><h4 id="slack-step-channel">{t("팀 공유 채널")}</h4><p>{t("확정된 데일리와 스킵 사유를 공유할 채널과 기본 시간을 정합니다.")}</p></div>
      <div className="integration-step-body">{canManage && admin ? <div className="slack-daily-admin">
        <div className="slack-admin-grid"><label><span>{t("기본 시간")}</span><input aria-label={t("Slack 데일리 기본 시간")} type="time" value={admin.settings.reminderTime} onChange={(event) => setAdmin({ ...admin, settings: { ...admin.settings, reminderTime: event.target.value } })} /></label><label><span>{t("기본 시간대")}</span><select aria-label={t("Slack 데일리 기본 시간대")} value={admin.settings.timezone} onChange={(event) => setAdmin({ ...admin, settings: { ...admin.settings, timezone: event.target.value } })}><option>Asia/Seoul</option><option>America/Los_Angeles</option><option>America/New_York</option><option>Europe/London</option><option>Asia/Tokyo</option></select></label></div>
        <div className="slack-weekdays" aria-label={t("Slack 데일리 기본 요일")}>{[t("일"), t("월"), t("화"), t("수"), t("목"), t("금"), t("토")].map((label, day) => <label key={label}><input type="checkbox" checked={admin.settings.weekdays.includes(day)} onChange={(event) => setAdmin({ ...admin, settings: { ...admin.settings, weekdays: event.target.checked ? [...admin.settings.weekdays, day].sort() : admin.settings.weekdays.filter((entry) => entry !== day) } })} />{label}</label>)}</div>
        <fieldset><legend>{t("개인 카드 공유 채널")}</legend><SlackChannelSyncStatus loading={channelsLoading} error={channelLoadError} onRefresh={() => void refreshChannels(false)} />{availableChannels.length ? availableChannels.map((channel) => <label key={channel.id}><input type="checkbox" checked={admin.channels.some((entry) => entry.id === channel.id)} onChange={(event) => setAdmin({ ...admin, channels: event.target.checked ? [...admin.channels, channel] : admin.channels.filter((entry) => entry.id !== channel.id) })} /><span>{slackChannelOptionLabel(channel)}</span></label>) : <p>{t("선택 가능한 채널이 없습니다. 비공개·Slack Connect 채널은 Slack에서 OKRI 봇을 먼저 초대해 주세요.")}</p>}</fieldset>
        <div className="slack-admin-actions"><button disabled={busy} onClick={() => void patchAdmin({ reminderTime: admin.settings.reminderTime, timezone: admin.settings.timezone, weekdays: admin.settings.weekdays, channelIds: admin.channels.map((channel) => channel.id) }, "Slack 데일리 기본 설정을 저장했습니다.")}>{busy ? t("저장 중") : t("팀 공유 설정 저장")}</button></div>
      </div> : <div className="integration-role-note">{t("팀 기본 시간과 공유 채널은 Owner 또는 Admin이 관리합니다.")}</div>}</div>
    </section>

    <section className="integration-step" aria-labelledby="slack-step-test">
      <span className="integration-step-number">5</span><div className="integration-step-copy"><h4 id="slack-step-test">{t("테스트 DM과 작동 확인")}</h4><p>{t("사용자 연결과 다음 알림 예약을 확인하고 실제 테스트 DM을 보냅니다.")}</p></div>
      <div className="integration-step-body">{canManage && admin ? <><div className="slack-admin-actions"><button disabled={busy} onClick={() => void patchAdmin({ action: "resync" }, t("Slack 사용자와 예약을 재동기화했습니다."))}><RefreshCw size={13} />{t("사용자·예약 재동기화")}</button></div><div className="slack-member-links slack-test-list">{admin.members.map((member) => <div key={member.memberId}><span className={member.linked ? "linked" : "unlinked"} /><p><b>{member.displayName}</b><small>{member.linked ? member.reminder ? t("다음 알림 · {value1}", { value1: messageValue(slackReminderLabel(member.reminder.status)) }) : t("알림 예약 확인 필요") : t("Slack 미연결")}</small></p>{member.linked && <><button disabled={busy} onClick={() => void patchAdmin({ action: "test_dm", memberId: member.memberId }, t("{value1}님에게 테스트 DM을 보냈습니다.", { value1: messageValue(member.displayName) }))}>{t("테스트 DM")}</button><button disabled={busy || !admin.channels.length} onClick={() => void republishLatest(member)}>{t("최신 데일리 공유")}</button></>}</div>)}</div>{admin.failedPublications.length > 0 && <div className="slack-publication-failures"><b>{t("채널 전송 실패")}</b>{admin.failedPublications.map((failure) => <div key={failure.id}><p>{failure.memberName} · {failure.date} · {admin.channels.find((channel) => channel.id === failure.channelId)?.name ?? t("공유 채널")}<small>{slackErrorMessage(failure.error)}</small></p><button disabled={busy} onClick={() => void patchAdmin({ action: "retry_publication", publicationId: failure.id }, t("채널 전송을 다시 시도했습니다."))}>{t("재시도")}</button></div>)}</div>}</> : <div className="integration-connected-note"><CheckCircle2 size={15} />{t("연결된 사용자는 Slack에서 `/okri daily`로 언제든 데일리를 열 수 있습니다.")}</div>}</div>
    </section></>}
  </div>;
}

type SlackAutomationDraft = {
  name: string;
  triggerType: SlackAutomationTrigger;
  triggerStatus: string;
  channelId: string;
  messageTemplate: string;
  messageTemplateKind?: "custom" | "default" | "blocked";
  active: boolean;
};

const slackAutomationDefaults: Record<SlackAutomationTrigger, string> = {
  task_changed: "*{{title}}*\n{{changes}}\n{{parent}} · {{workspace}}",
  task_created: "새 업무가 등록되었습니다.\n*{{title}}*\n상태: {{status}} · 우선순위: {{priority}} · {{workspace}}",
  task_status_changed: "*{{title}}* 상태가 `{{from_status}}` → `{{status}}`로 바뀌었습니다.\n우선순위: {{priority}} · {{workspace}}",
};

function emptySlackAutomationDraft(triggerType: SlackAutomationTrigger = "task_created"): SlackAutomationDraft {
  return { name: "", triggerType, triggerStatus: "", channelId: "", messageTemplate: slackAutomationDefaults[triggerType], messageTemplateKind: "default", active: true };
}

async function fetchSlackAutomationData() {
  const response = await fetch("/api/slack/automations");
  const data = await response.json() as { automations?: SlackAutomation[]; deliveries?: SlackAutomationDelivery[]; messageLanguage?: Language; error?: string };
  if (!response.ok) throw new Error(apiError(data, "자동화를 불러오지 못했습니다."));
  const messageLanguage = data.messageLanguage ?? "ko";
  await loadLanguage(messageLanguage);
  return { automations: data.automations ?? [], deliveries: data.deliveries ?? [], messageLanguage };
}

const slackAutomationRecommendations = [
  { id: "changed", name: "모든 Task 변동", description: "생성·수정·담당자·속성·삭제·복구를 모두 알립니다.", triggerType: "task_changed" as const, triggerStatus: "", messageTemplate: slackAutomationDefaults.task_changed },
  { id: "created", name: "새 Task 알림", description: "새 Task가 만들어지면 담당 채널에 알립니다.", triggerType: "task_created" as const, triggerStatus: "", messageTemplate: slackAutomationDefaults.task_created },
  { id: "completed", name: "Task 완료 알림", description: "Task가 완료되면 담당 채널에 알립니다.", triggerType: "task_status_changed" as const, triggerStatus: "done", messageTemplate: slackAutomationDefaults.task_status_changed },
  { id: "reopened", name: "Task 다시 열림 알림", description: "완료한 Task가 다시 열리면 담당 채널에 알립니다.", triggerType: "task_status_changed" as const, triggerStatus: "todo", messageTemplate: slackAutomationDefaults.task_status_changed },
] as const;

function slackAutomationHealthLabel(automations: SlackAutomation[]) {
  const active = automations.filter((entry) => entry.active);
  if (active.some((entry) => entry.lastDeliveryStatus === "failed")) return "전송 확인 필요";
  if (active.some((entry) => entry.lastDeliveryStatus === "pending")) return "발송 처리 중";
  return active.length ? "사용 중" : automations.length ? "중지" : "설정 필요";
}

function SlackAutomationManager({ active, connected, canManage, workspaceName, onSummary, onNotice }: { active: boolean; connected: boolean; canManage: boolean; workspaceName: string; onSummary: (status: string, summary: string) => void; onNotice: (message: string) => void }) {
  const { language } = useLanguage();
  const confirmAction = useAppConfirm();
  const [messageLanguage, setMessageLanguage] = useState<Language>("ko");
  const [automations, setAutomations] = useState<SlackAutomation[]>([]);
  const [deliveries, setDeliveries] = useState<SlackAutomationDelivery[]>([]);
  const [recommendedChannels, setRecommendedChannels] = useState<Record<string, string>>({ changed: "", created: "", completed: "", reopened: "" });
  const [loading, setLoading] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState<SlackAutomationDraft>(emptySlackAutomationDraft());
  const [formOpen, setFormOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const loadedRef = useRef(false);
  const { channels, loading: channelsLoading, error: channelLoadError, refresh: refreshChannels } = useLiveSlackChannels(active && connected && canManage);

  useEffect(() => {
    if (!active || !connected || loadedRef.current) return;
    loadedRef.current = true;
    let mounted = true;
    let completed = false;
    setLoading(true);
    void fetchSlackAutomationData()
      .then((data) => {
        completed = true;
        if (!mounted) return;
        setAutomations(data.automations);
        setDeliveries(data.deliveries);
        setMessageLanguage(data.messageLanguage);
        const activeCount = data.automations.filter((entry) => entry.active).length;
        onSummary(slackAutomationHealthLabel(data.automations), t("활성 규칙 {value1}개 · 전체 {value2}개", { value1: messageValue(activeCount), value2: messageValue(data.automations.length) }));
      })
      .catch((error: unknown) => {
        completed = true;
        if (mounted) { onSummary("불러오기 실패", "설정을 다시 확인해 주세요"); onNotice(slackErrorMessage(error, "자동화를 불러오지 못했습니다.")); }
      })
      .finally(() => { if (mounted) { setLoading(false); setLoaded(true); } });
    return () => {
      mounted = false;
      if (!completed) loadedRef.current = false;
    };
  }, [active, canManage, connected, onNotice, onSummary]);

  useEffect(() => {
    if (connected || !active) return;
    onSummary("연결 필요", "Slack 연결 후 설정할 수 있습니다");
  }, [active, connected, onSummary]);

  useEffect(() => {
    if (!loaded || !connected) return;
    const activeCount = automations.filter((entry) => entry.active).length;
    onSummary(slackAutomationHealthLabel(automations), t("활성 규칙 {value1}개 · 전체 {value2}개", { value1: messageValue(activeCount), value2: messageValue(automations.length) }));
  }, [automations, connected, language, loaded, onSummary]);

  async function loadAutomations(showLoading = true) {
    if (showLoading) setLoading(true);
    try {
      const data = await fetchSlackAutomationData();
      setAutomations(data.automations);
      setDeliveries(data.deliveries);
      setMessageLanguage(data.messageLanguage);
      const activeCount = data.automations.filter((entry) => entry.active).length;
      onSummary(slackAutomationHealthLabel(data.automations), t("활성 규칙 {value1}개 · 전체 {value2}개", { value1: messageValue(activeCount), value2: messageValue(data.automations.length) }));
    } catch (error) {
      onNotice(slackErrorMessage(error, "자동화를 불러오지 못했습니다."));
    } finally {
      if (showLoading) setLoading(false);
    }
  }

  function startCreate() {
    setEditingId(null);
    setDraft(emptySlackAutomationDraft());
    setFormOpen(true);
  }

  function startEdit(automation: SlackAutomation) {
    setEditingId(automation.id);
    setDraft({ name: automation.name, triggerType: automation.triggerType, triggerStatus: automation.triggerStatus, channelId: automation.channelId, messageTemplate: automation.messageTemplate, messageTemplateKind: automation.messageTemplateKind ?? "custom", active: automation.active });
    setFormOpen(true);
  }

  async function createRecommendedAutomation(recommendation: (typeof slackAutomationRecommendations)[number]) {
    const channelId = recommendedChannels[recommendation.id];
    if (!channelId) { onNotice(t("추천 자동화를 보낼 Slack 채널을 선택해 주세요.")); return; }
    const duplicate = automations.find((entry) => entry.channelId === channelId && entry.triggerType === recommendation.triggerType && entry.triggerStatus === recommendation.triggerStatus);
    if (duplicate) { onNotice(t("같은 채널에 '{value1}' 규칙이 이미 있습니다.", { value1: messageValue(duplicate.name) })); return; }
    setBusyId(`recommended:${recommendation.id}`);
    try {
      const localizedName = translateForLanguage(messageLanguage, recommendation.name);
      const response = await fetch("/api/slack/automations", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: localizedName, triggerType: recommendation.triggerType, triggerStatus: recommendation.triggerStatus, channelId, messageTemplate: recommendation.messageTemplate, messageTemplateKind: "default", active: true }) });
      const data = await response.json() as { automation?: SlackAutomation; error?: string };
      if (!response.ok || !data.automation) throw new Error(apiError(data, "추천 자동화를 만들지 못했습니다."));
      const next = [data.automation, ...automations];
      setAutomations(next);
      onSummary(slackAutomationHealthLabel(next), t("활성 규칙 {value1}개 · 전체 {value2}개", { value1: messageValue(next.filter((entry) => entry.active).length), value2: messageValue(next.length) }));
      onNotice(t("'{value1}' 추천 자동화를 만들었습니다.", { value1: messageValue(t(recommendation.name)) }));
    } catch (error) {
      onNotice(slackErrorMessage(error, "추천 자동화를 만들지 못했습니다."));
    } finally {
      setBusyId(null);
    }
  }

  async function saveAutomation(event: FormEvent) {
    event.preventDefault();
    if (!draft.name.trim() || !draft.channelId.trim() || !draft.messageTemplate.trim()) { onNotice(t("이름, 채널 ID, 메시지를 모두 입력해 주세요.")); return; }
    setSaving(true);
    try {
      const response = await fetch("/api/slack/automations", {
        method: editingId ? "PATCH" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...(editingId ? { id: editingId } : {}), ...draft }),
      });
      const data = await response.json() as { automation?: SlackAutomation; error?: string };
      if (!response.ok || !data.automation) throw new Error(apiError(data, "자동화를 저장하지 못했습니다."));
      setAutomations((current) => {
        const next = editingId ? current.map((entry) => entry.id === editingId ? data.automation! : entry) : [data.automation!, ...current];
        const activeCount = next.filter((entry) => entry.active).length;
        onSummary(slackAutomationHealthLabel(next), t("활성 규칙 {value1}개 · 전체 {value2}개", { value1: messageValue(activeCount), value2: messageValue(next.length) }));
        return next;
      });
      setFormOpen(false);
      setEditingId(null);
      onNotice(editingId ? t("Slack 자동화를 수정했습니다.") : t("Slack 자동화를 만들었습니다. 테스트 전송으로 확인해 보세요."));
    } catch (error) {
      onNotice(slackErrorMessage(error, "자동화를 저장하지 못했습니다."));
    } finally {
      setSaving(false);
    }
  }

  async function toggleAutomation(automation: SlackAutomation) {
    setBusyId(automation.id);
    try {
      const response = await fetch("/api/slack/automations", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id: automation.id, active: !automation.active }) });
      const data = await response.json() as { automation?: SlackAutomation; error?: string };
      if (!response.ok || !data.automation) throw new Error(apiError(data, "상태를 바꾸지 못했습니다."));
      setAutomations((current) => {
        const next = current.map((entry) => entry.id === automation.id ? data.automation! : entry);
        const activeCount = next.filter((entry) => entry.active).length;
        onSummary(slackAutomationHealthLabel(next), t("활성 규칙 {value1}개 · 전체 {value2}개", { value1: messageValue(activeCount), value2: messageValue(next.length) }));
        return next;
      });
    } catch (error) {
      onNotice(slackErrorMessage(error, "상태를 바꾸지 못했습니다."));
    } finally {
      setBusyId(null);
    }
  }

  async function testSend(automation: SlackAutomation) {
    setBusyId(automation.id);
    try {
      const response = await fetch("/api/slack/automations/test", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id: automation.id }) });
      const data = await response.json() as { error?: string };
      if (!response.ok) throw new Error(apiError(data, "테스트 전송에 실패했습니다."));
      onNotice(t("#{value1} 채널로 테스트 메시지를 보냈습니다.", { value1: messageValue(automation.channelId) }));
    } catch (error) {
      onNotice(slackErrorMessage(error, "테스트 전송에 실패했습니다."));
    } finally {
      await loadAutomations(false);
      setBusyId(null);
    }
  }

  async function removeAutomation(automation: SlackAutomation) {
    if (!await confirmAction({ title: t("Slack 자동화 삭제"), message: t("'{value1}' 자동화와 전송 기록을 삭제합니다.", { value1: messageValue(automation.name) }), confirmLabel: t("자동화 삭제"), danger: true })) return;
    setBusyId(automation.id);
    try {
      const response = await fetch(`/api/slack/automations?id=${encodeURIComponent(automation.id)}`, { method: "DELETE" });
      const data = await response.json() as { error?: string };
      if (!response.ok) throw new Error(apiError(data, "자동화를 삭제하지 못했습니다."));
      setAutomations((current) => {
        const next = current.filter((entry) => entry.id !== automation.id);
        const activeCount = next.filter((entry) => entry.active).length;
        onSummary(slackAutomationHealthLabel(next), t("활성 규칙 {value1}개 · 전체 {value2}개", { value1: messageValue(activeCount), value2: messageValue(next.length) }));
        return next;
      });
      setDeliveries((current) => current.filter((entry) => entry.automationId !== automation.id));
      onNotice(t("Slack 자동화를 삭제했습니다."));
    } catch (error) {
      onNotice(slackErrorMessage(error, "자동화를 삭제하지 못했습니다."));
    } finally {
      setBusyId(null);
    }
  }

  if (!active && !loaded) return null;
  if (!connected) return <div className="slack-automation-locked"><Zap size={16} /><div><b>{t("Slack 연결 후 Task 변동 알림 봇을 설정할 수 있습니다")}</b><p>{t("연결을 완료하면 Task의 생성부터 수정·삭제까지 채널로 알릴 수 있습니다.")}</p></div></div>;

  return <div className="slack-automation-manager">
    {canManage && <SlackChannelSyncStatus loading={channelsLoading} error={channelLoadError} onRefresh={() => void refreshChannels(false)} />}
    {canManage && <section className="automation-recommendations"><header><h3>{t("추천 자동화")}</h3><p>{t("발송 채널만 고르면 추천 조건과 메시지로 바로 시작합니다.")}</p></header><div>{slackAutomationRecommendations.map((recommendation) => <article key={recommendation.id}><div><b>{t(recommendation.name)}</b><p>{t(recommendation.description)}</p></div><select aria-label={t("{value1} Slack 채널", { value1: messageValue(t(recommendation.name)) })} value={recommendedChannels[recommendation.id]} onChange={(event) => setRecommendedChannels((current) => ({ ...current, [recommendation.id]: event.target.value }))}><option value="">{t("채널 선택")}</option>{channels.map((channel) => <option value={channel.id} key={channel.id}>{slackChannelOptionLabel(channel)}</option>)}</select><button type="button" disabled={busyId === `recommended:${recommendation.id}`} onClick={() => void createRecommendedAutomation(recommendation)}>{busyId === `recommended:${recommendation.id}` ? <LoaderCircle className="spin" size={13} /> : <Plus size={13} />}{t("추가")}</button></article>)}</div></section>}
    <div className="slack-automation-heading"><div><h3>{t("현재 자동화")}</h3><p>{t("{workspace}에서 작동하는 규칙입니다.", { workspace: workspaceName })}</p></div>{canManage && <button type="button" onClick={startCreate}><Plus size={14} />{t("직접 규칙 만들기")}</button>}</div>
    <div className="slack-bot-note"><Bot size={15} /><p>{t("각 자동화는 독립된 규칙으로 작동하며, 메시지는 연결된 OKRI 봇 이름으로 전송됩니다.")}</p></div>
    {formOpen && <form className="slack-automation-form" onSubmit={(event) => void saveAutomation(event)}>
      <div className="slack-form-title"><b>{editingId ? t("자동화 수정") : t("새 자동화")}</b><button type="button" className="icon-button" onClick={() => setFormOpen(false)} aria-label={t("작성 취소")}><X size={14} /></button></div>
      <div className="slack-form-grid">
        <label><span>{t("자동화 이름")}</span><input value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value })} placeholder={t("예: 새 업무 알림")} maxLength={80} /></label>
        <label><span>{t("Slack 발송 채널")}</span><select value={draft.channelId} onChange={(event) => setDraft({ ...draft, channelId: event.target.value })}><option value="">{t("채널 선택")}</option>{draft.channelId && !channels.some((channel) => channel.id === draft.channelId) && <option value={draft.channelId}>#{draft.channelId}</option>}{channels.map((channel) => <option value={channel.id} key={channel.id}>{slackChannelOptionLabel(channel)}</option>)}</select></label>
        <label><span>{t("트리거")}</span><select value={draft.triggerType} onChange={(event) => { const triggerType = event.target.value as SlackAutomationTrigger; setDraft({ ...draft, triggerType, triggerStatus: triggerType === "task_status_changed" ? "done" : "", messageTemplate: slackAutomationDefaults[triggerType], messageTemplateKind: "default" }); }}><option value="task_changed">{t("모든 Task 변동")}</option><option value="task_created">{t("Task 생성")}</option><option value="task_status_changed">{t("Task 완료 또는 다시 열림")}</option></select></label>
        {draft.triggerType === "task_status_changed" && <label><span>{t("변동")}</span><select value={draft.triggerStatus} onChange={(event) => setDraft({ ...draft, triggerStatus: event.target.value })}><option value="done">{t("Task 완료")}</option><option value="todo">{t("Task 다시 열림")}</option></select></label>}
      </div>
      <label className="slack-message-field"><span>{t("보낼 메시지")}</span><textarea value={draft.messageTemplateKind && draft.messageTemplateKind !== "custom" ? translateForLanguage(messageLanguage, draft.messageTemplate) : draft.messageTemplate} onChange={(event) => setDraft({ ...draft, messageTemplate: event.target.value, messageTemplateKind: "custom" })} maxLength={3000} rows={4} /></label>
      <p>{t(draft.messageTemplateKind && draft.messageTemplateKind !== "custom" ? "기본 문구는 워크스페이스 공용 언어로 발송됩니다." : "사용자 문구는 번역하지 않고 그대로 발송합니다.")} <button type="button" onClick={() => setDraft({ ...draft, messageTemplate: slackAutomationDefaults[draft.triggerType], messageTemplateKind: "default" })}>{t("기본 문구 사용")}</button></p>
      <div className="slack-variable-row"><span>{t("변수")}</span>{["{{title}}", "{{status}}", "{{from_status}}", "{{priority}}", "{{workspace}}", "{{changes}}", "{{parent}}"].map((variable) => <button type="button" key={variable} onClick={() => { const message = draft.messageTemplateKind && draft.messageTemplateKind !== "custom" ? translateForLanguage(messageLanguage, draft.messageTemplate) : draft.messageTemplate; setDraft({ ...draft, messageTemplate: `${message}${message.endsWith(" ") || message.endsWith("\n") ? "" : " "}${variable}`, messageTemplateKind: "custom" }); }}>{variable}</button>)}</div>
      <p className="slack-channel-help">{t("공개 채널은 선택할 때 봇이 참여합니다. 비공개·Slack Connect 채널은 봇이 이미 참여한 경우만 표시됩니다.")}</p>
      <div className="slack-form-actions"><label><input type="checkbox" checked={draft.active} onChange={(event) => setDraft({ ...draft, active: event.target.checked })} /><span>{t("저장 즉시 활성화")}</span></label><div><button type="button" onClick={() => setFormOpen(false)}>{t("취소")}</button><button type="submit" disabled={saving}>{saving ? <LoaderCircle className="spin" size={13} /> : <Check size={13} />}{saving ? t("저장 중") : t("저장")}</button></div></div>
    </form>}
    {loading ? <div className="slack-automation-loading"><LoaderCircle className="spin" size={16} />{t("자동화를 불러오는 중")}</div> : automations.length === 0 ? <div className="slack-automation-empty"><Zap size={18} /><b>{t("아직 자동화가 없습니다.")}</b><p>{canManage ? t("새 자동화를 만들어 첫 Slack 알림을 보내보세요.") : t("워크스페이스 관리자가 자동화를 만들 수 있습니다.")}</p></div> : <div className="slack-automation-list">{automations.map((automation) => <article key={automation.id} className={automation.active ? "" : "inactive"}>
      <div className="slack-automation-main"><span className={`slack-delivery-dot ${automation.lastDeliveryStatus}`} /><div><b>{automation.name}</b><p>{slackTriggerLabel(automation)} · #{automation.channelId}</p></div><span className={`slack-automation-state ${automation.active ? "active" : ""}`}>{automation.active ? t("활성") : t("중지")}</span></div>
      <div className="slack-automation-meta">{automation.supported === false ? t("현재 Task 상태 모델에서는 사용할 수 없음") : automation.lastDeliveryStatus === "never" ? t("아직 전송 이력 없음") : automation.lastDeliveryStatus === "sent" ? t("{value1} 전송 성공", { value1: messageValue(formatSlackAutomationTime(automation.lastTriggeredAt)) }) : automation.lastError ? slackErrorMessage(automation.lastError) : (automation.lastDeliveryStatus === "pending" ? t("발송 처리 중") : t("최근 전송 실패"))}</div>
      {canManage && <div className="slack-automation-actions"><button type="button" onClick={() => void testSend(automation)} disabled={busyId === automation.id || automation.supported === false}>{busyId === automation.id ? <LoaderCircle className="spin" size={12} /> : <Send size={12} />}{t("테스트")}</button><button type="button" onClick={() => void toggleAutomation(automation)} disabled={busyId === automation.id || automation.supported === false}>{automation.active ? t("중지") : t("활성화")}</button><button type="button" onClick={() => startEdit(automation)}><Pencil size={12} />{t("수정")}</button><button type="button" className="danger" onClick={() => void removeAutomation(automation)} disabled={busyId === automation.id} aria-label={t("{value1} 삭제", { value1: messageValue(automation.name) })}><Trash2 size={12} /></button></div>}
    </article>)}</div>}
    {deliveries.length > 0 && <details className="slack-delivery-history"><summary>{t("최근 전송 기록")}<span>{deliveries.length}</span><ChevronDown size={13} /></summary><div>{deliveries.slice(0, 8).map((delivery) => <div key={delivery.id}><span className={`slack-delivery-dot ${delivery.status}`} /><p><b>{delivery.status === "sent" ? t("전송 성공") : delivery.status === "failed" ? t("전송 실패") : t("전송 중")}</b><small>#{delivery.channelId} · {formatSlackAutomationTime(delivery.sentAt || delivery.createdAt)}</small>{delivery.error && <em>{slackErrorMessage(delivery.error)}</em>}</p></div>)}</div></details>}
  </div>;
}

function slackTriggerLabel(automation: SlackAutomation) {
  if (automation.triggerType === "task_changed") return t("모든 Task 변동");
  if (automation.triggerType === "task_created") return t("Task 생성");
  if (automation.triggerStatus === "done") return t("Task 완료");
  if (automation.triggerStatus === "todo") return t("Task 다시 열림");
  return t("지원하지 않는 과거 상태 규칙");
}

function formatSlackAutomationTime(value: string | null) {
  if (!value) return "-";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString(getClientLocale(), { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

function EmptyState({ icon: Icon, title }: { icon: LucideIcon; title: string }) { return <div className="empty-state"><Icon size={22} /><span>{title}</span></div>; }

const statusLabels: Record<ItemStatus, string> = { get backlog() { return t("백로그"); }, get todo() { return t("할 일"); }, get policy_discussion() { return t("정책 논의 중"); }, get in_progress() { return t("진행 중"); }, get developing() { return t("개발 중"); }, get development_done() { return t("개발 완료"); }, get done() { return t("완료"); }, get blocked() { return t("막힘"); }, get archived() { return t("휴지통"); } };
const priorityLabels: Record<Priority, string> = { get low() { return t("낮음"); }, get medium() { return t("보통"); }, get high() { return t("높음"); }, get urgent() { return t("긴급"); } };
const groupColors: GroupColor[] = ["gray", "blue", "green", "yellow", "orange", "red", "purple"];

function kindLabel(kind: ItemKind) { return t({ objective: "Objective", key_result: "Key Result", initiative: "Initiative", project: "Project", task: "Task" }[kind]); }
function statusLabel(status: ItemStatus) { return statusLabels[status]; }
function isCompletedStatus(status: ItemStatus) { return status === "done" || status === "development_done"; }
function taskCompletionPatch(status: ItemStatus): Partial<OkriItem> { return { status: isCompletedStatus(status) ? "todo" : "done" }; }
function sourceLabel(source: string) { return { mcp: "MCP", codex: "Codex", slack: "Slack", discord: "Discord", telegram: "Telegram", web: "Web" }[source] ?? "Bot"; }
function propertyTypeLabel(type: PropertyType) { return t({ text: "텍스트", number: "숫자", select: "선택", date: "날짜", checkbox: "체크박스", member: "멤버 1명", members: "멤버 여러 명" }[type]); }
function propertySystemDefault(properties: PropertyDefinition[], systemKey: string, fallback: string) { const value = properties.find((property) => property.systemKey === systemKey && property.active)?.defaultValue; return typeof value === "string" ? value : fallback; }
function teamRoleLabel(role: TeamRole) { return t({ owner: "Owner", admin: "Admin", member: "Member", viewer: "Viewer" }[role]); }
function workspaceDeletionLabel(value: string | null) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "30일 후 영구 삭제";
  const days = Math.max(0, Math.ceil((date.getTime() - Date.now()) / 86_400_000));
  const deletionDate = date.toLocaleDateString(getClientLocale(), { month: "numeric", day: "numeric" });
  return t("{value1}일 남음 · {value2} 영구 삭제", { value1: messageValue(days), value2: messageValue(deletionDate) });
}
function groupColorLabel(color: GroupColor) { return t({ gray: "회색", blue: "파랑", green: "초록", yellow: "노랑", orange: "주황", red: "빨강", purple: "보라" }[color]); }
function dueLabel(value: string | null) { return value ? displayDate(value) : t("기한 없음"); }
function trashSummary(record: TrashRecord) { return t("OKR {value1}개, 작업 {value2}개, Routine {value3}개 보관", { value1: messageValue(record.cycleCount), value2: messageValue(record.itemCount), value3: messageValue(record.routineCount) }); }
function formatDateTime(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString(getClientLocale(), { dateStyle: "medium", timeStyle: "short" });
}
function localDate() { const now = new Date(); const offset = now.getTimezoneOffset() * 60_000; return new Date(now.getTime() - offset).toISOString().slice(0, 10); }
function pageSubtitle(view: View) { return t({ home: "자유롭게 이야기하면 OKR과 실행 항목으로 정리", my_work: "내가 담당하는 Project, Task, Routine", inbox: "워크스페이스 전체 Task 목록", work: "Initiative 아래의 Project 속성과 상태 관리", gantt: "Project 마감과 하위 Task 일정을 한눈에 확인", routines: "OKR과 독립된 반복 실행과 하위 Task 관리", okr: "Objective부터 Project·Task까지의 OKR 실행 구조", data: "Key Result와 Project에 외부 API 수치 연결", scrum: "내게 배정된 업무와 오늘의 진행 계획", recommendations: "현재 데이터에서 계산한 다음 정리 항목", reviews: "주기별 진행과 막힘", trash: "삭제한 Project·Task와 전체 데이터 정리 기록", integrations: "내 Google Calendar와 개인 Slack DM 연결", billing: "워크스페이스 플랜, 사용량, 카드와 결제 기록 관리" }[view]); }
function routineCadenceLabel(cadence: RoutineCadence) { return t({ daily: "매일", weekly: "매주", monthly: "매월" }[cadence]); }
function recommendationIcon(kind: Recommendation["kind"]) { if (kind === "blocked") return "!"; if (kind === "overdue") return "D"; if (kind === "due_soon") return "3"; return "P"; }
