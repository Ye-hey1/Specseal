// @specseal/ui — 跨桌面/web 共用的呈现组件库。
//
// 组件为纯呈现、数据由 props 注入；数据源经 SpecsealDataSource 接口解耦（见 adapter.ts）。

export const UI_PACKAGE = "@specseal/ui";

// UI 接口 i18n（zh-CN／en；与 config locale 无关）
export {
  I18nProvider,
  useI18n,
  MESSAGES,
  translatorFor,
  dictionaryProblems,
  type Translator,
  type UiLocale,
  type I18nProviderProps,
} from "./i18n";
export {
  detectSystemLocale,
  readLocalePreference,
  writeLocalePreference,
  resolveUiLocale,
  type LocalePreference,
} from "./locale";
export {
  readThemePreference,
  writeThemePreference,
  THEME_STORAGE_KEY,
  applyThemePreference,
  type ThemePreference,
} from "./theme";

// shadcn/ui 设计系统原语（跨桌面/web 共用）
export { cn } from "./lib/utils";
export { Toaster } from "./components/ui/sonner";
export { Button, buttonVariants, type ButtonProps } from "./components/ui/button";
export {
  Card,
  CardHeader,
  CardTitle,
  CardContent,
  CardFooter,
} from "./components/ui/card";
export { Badge, badgeVariants, type BadgeProps } from "./components/ui/badge";
export { StatusPill, type StatusPillLabel, type StatusPillTone } from "./components/ui/status-pill";
export { Callout, type CalloutProps, type CalloutTone } from "./components/ui/callout";
export {
  Table,
  TableHeader,
  TableBody,
  TableRow,
  TableHead,
  TableCell,
  TableCaption,
} from "./components/ui/table";
export {
  AlertDialog,
  AlertDialogContent,
  AlertDialogHeader,
  AlertDialogFooter,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogAction,
  AlertDialogCancel,
} from "./components/ui/alert-dialog";
export { ConfirmDialog, type ConfirmDialogProps } from "./components/ui/confirm-dialog";
export { Label } from "./components/ui/label";
export {
  Sheet,
  SheetContent,
  SheetTrigger,
  SheetClose,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from "./components/ui/sheet";

export type {
  SpecsealDataSource,
  CardKind,
  ListView,
  ChangeItem,
  ChangeListPayload,
  UnpromotedCutItem,
  ChangeOverlap,
  ChangeRequirementOverlap,
  DeltaOperation,
  SpecItem,
  ArchivedItem,
  DiscussionItem,
  DiscussionLists,
  DiscussionCut,
  DiscussionDocument,
  ManualIndex,
  ManualPageItem,
  SearchHit,
  Verb,
  AnalyzeFinding,
  AnalyzeDimension,
  AnalyzeReport,
  VerbDrawerResult,
  RevertBlockedEvidence,
  TicketStation,
  TicketFinding,
  TicketRound,
  StationTicket,
  ReviewBaseline,
  ReviewList,
  ReviewRules,
} from "./adapter";
export { RevertBlockedError, toRevertError, emptyManualIndex, REVIEW_LISTS, DEFAULT_SPEC_DIR } from "./adapter";
export {
  RevertBlockedDialog,
  type RevertBlockedInfo,
  type RevertBlockedDialogProps,
} from "./components/RevertBlockedDialog";
export { cardDndId, parseCardDndId, resolveCardDrop, type ColumnCards } from "./boardDnd";
export { DocumentTree } from "./components/DocumentTree";
export type { DocumentTreeProps, TreeSelection } from "./components/DocumentTree";
export { DocumentViewer } from "./components/DocumentViewer";
export type { DocumentViewerProps } from "./components/DocumentViewer";
export { TicketView, type TicketViewProps } from "./components/TicketView";
export { SeverityTag } from "./components/SeverityTag";
export { BaselineSmellList } from "./components/BaselineSmellList";

// 列滑过才出现的控制项（拷贝钮、撤销钮）共用的显隐 class
export { REVEAL_ON_GROUP_HOVER } from "./reveal";

// 状态语意色（单一来源；三红分工见 tone.ts 表头）
export { SEMANTIC_TONE, SEMANTIC_SURFACE, type SemanticTone } from "./tone";

// 看板
export {
  changeStage,
  DISCUSSION_TONE,
  planArchiveAfter,
  planBlockedBy,
  planBlockedLabel,
  planRequirementOverlap,
  planWave,
  planWaveLabel,
  STAGE_BADGE,
  STAGE_BAR,
  STAGE_ICON,
  STAGES,
  type Stage,
} from "./stage";
export { siblingChangesOf } from "./siblings";
export { parseTasks, type TaskLine } from "./tasks";
export type { ArtifactStatus, StatusReport } from "./adapter";
export { ChangeCard, type ChangeCardProps } from "./components/ChangeCard";
export { KanbanBoard, type KanbanBoardProps } from "./components/KanbanBoard";
export { RoadmapView, BoardViewSwitch, type BoardMode, type RoadmapViewProps } from "./components/RoadmapView";
export {
  DiscussionColumn,
  discussionChipStage,
  type DiscussionColumnProps,
} from "./components/DiscussionColumn";
export { DiscussionDetailPage, type DiscussionDetailPageProps } from "./components/DiscussionDetailPage";

// 清单 + 分页 + 富文本
export { Markdown, type MarkdownProps } from "./components/Markdown";
export { Tabs, TabsList, TabsTrigger, TabsContent } from "./components/ui/tabs";
export { Input } from "./components/ui/input";
export { Tooltip, TooltipTrigger, TooltipContent, TooltipProvider } from "./components/ui/tooltip";
export {
  SELECT_ALL,
  Select,
  SelectGroup,
  SelectValue,
  SelectTrigger,
  SelectContent,
  SelectLabel,
  SelectItem,
  SelectSeparator,
} from "./components/ui/select";
export { Checkbox, type CheckboxProps } from "./components/ui/checkbox";
export { Switch, type SwitchProps } from "./components/ui/switch";
export {
  SettingsPageHeader,
  SettingsCard,
  SettingsRow,
  SettingsLinkRow,
  SettingsChoice,
  SettingsGroupHeader,
  type SettingsChoiceOption,
  type SettingsChoiceGroup,
  isSettingsChoiceGroup,
} from "./components/ui/settings";
export {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
} from "./components/ui/dropdown-menu";
export {
  ContextMenu,
  ContextMenuTrigger,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuLabel,
  ContextMenuSeparator,
} from "./components/ui/context-menu";
export { Kbd, MenuShortcut } from "./components/ui/kbd";
export { PageHeader } from "./components/ui/page-header";
export { Breadcrumbs, type Crumb } from "./components/Breadcrumbs";
export { DetailNav } from "./components/DetailNav";
export { StepProgress } from "./components/StepProgress";
export { Textarea, type TextareaProps } from "./components/ui/textarea";
export { Skeleton } from "./components/ui/skeleton";
export {
  CardSkeleton,
  ColumnSkeleton,
  ColumnLoadFailed,
  RowSkeleton,
  DocSkeleton,
} from "./components/skeletons";

// 富详情
export type { ChangeMetaInfo } from "./adapter";
export { specDeltaCounts, sumDeltaCounts, formatDeltaCounts, type DeltaCounts } from "./delta";
export { ChangeDetailPage, type ChangeDetailPageProps } from "./components/ChangeDetailPage";
export { IdentityName, displayName, type DocumentRef, type DocumentTarget } from "./components/DetailHeader";
export {
  DetailShell,
  DetailIdentity,
  DetailTreeLabel,
  DetailStatus,
  DocHeader,
  DocTiles,
  DocBody,
  DetailActions,
  DetailActionsSlot,
  DetailActionsSlotProvider,
  type DetailShellProps,
  type DetailIdentityProps,
  type DetailRelation,
  type DocHeaderProps,
} from "./components/DetailShell";

// 交互任务、彩色 delta、封存页
export { parseTaskDoc, type TaskDocItem } from "./tasks";
export { TaskList, type TaskListProps } from "./components/TaskList";
export { DeltaBadges, CapabilityHeader } from "./components/DeltaBadges";
// 变更文档渲染器（desktop-change-doc-views）：提案、设计、需求段、调度与阅读卡标题区的推导。
export { ProposalDoc, type ProposalDocProps } from "./components/ProposalDoc";
export { DesignDoc, type DesignDocProps, type DecisionJump } from "./components/DesignDoc";
export { PlanDoc } from "./components/PlanDoc";
export { RequirementBlock, type RequirementBlockProps, type RequirementDelta } from "./components/RequirementBlock";
export { changeDocSummary, type ChangeDocData } from "./components/changeDocSummary";
export {
  splitH2Sections,
  parseListItems,
  listItemsOf,
  splitAlternative,
  parseImpact,
  parseCapabilities,
  parseGoalsNonGoals,
  parseDecisions,
  parseContractRows,
  splitRisk,
  splitTaskText,
  newCapabilities,
  removedScenarios,
  splitScenarioSteps,
  findingAxis,
  proposalShape,
  type H2Section,
  type SplitDoc,
  type ListItem,
  type ListBlock,
  type ImpactData,
  type CapabilityRow,
  type DecisionData,
  type TaskTextParts,
} from "./docModel";
// 讨论文档渲染器（desktop-discussion-doc-views）：结论、讨论过程、背景、衍生变更与阅读卡标题区的推导。
export { ConclusionDoc, type ConclusionDocProps, type CutStage } from "./components/ConclusionDoc";
export { RoundsDoc } from "./components/RoundsDoc";
export { ContextDoc, type ContextDocProps } from "./components/ContextDoc";
export { PromotedDoc, promotedRows, type PromotedRow } from "./components/PromotedDoc";
export {
  discussionDocSummary,
  discussionDocProvenance,
  discussionDocData,
  type DiscussionDocData,
} from "./components/discussionDocSummary";
// 记录解析器留在套件内部；只延续原本就公开的区段切分。
export { splitDiscussionSections, type DiscussionSections } from "./discussionModel";
export { CopyButton, type CopyButtonProps } from "./components/CopyButton";
export { EmptyState, type EmptyStateProps } from "./components/EmptyState";
export { SectionHeader, type SectionHeaderProps } from "./components/SectionHeader";
export { BrandMark, Wordmark } from "./components/Brand";
export { NavItem, type NavItemProps } from "./components/NavItem";
export { ListRow, type ListRowProps } from "./components/ListRow";
export { ListCard, type ListCardProps } from "./components/ListCard";
export {
  ListPager,
  usePaging,
  PAGE_SIZE,
  PAGE_SIZE_OPTIONS,
  type ListPagerProps,
} from "./components/ListPager";
export { SearchField, type SearchFieldProps } from "./components/SearchField";
export { ArchivedList, type ArchivedListProps } from "./components/ArchivedList";
export { ArchivedDetailPage, type ArchivedDetailPageProps, type ArchivedTarget } from "./components/ArchivedDetailPage";
export { ReviewArchiveDialog, type ReviewArchiveDialogProps } from "./components/ReviewArchiveDialog";
export {
  REVIEW_ICON,
  REVIEW_LABEL_KEY,
  REVIEW_PILL_TONE,
  REVIEW_TONE,
  type ReviewBadgeStatus,
} from "./components/reviewStyle";
export {
  VERIFY_ICON,
  VERIFY_LABEL_KEY,
  VERIFY_PILL_TONE,
  VERIFY_TONE,
  type VerifyBadgeStatus,
} from "./components/verifyStyle";

// 规格页
export { SpecList, sortSpecs, type SpecListProps } from "./components/SpecList";
export { SpecDetailPage, type SpecDetailPageProps } from "./components/SpecDetailPage";
export {
  parseSpecSections,
  type SpecRequirement,
  type SpecScenario,
  type SpecSections,
} from "./specSections";

// 手册页（desktop-manual-page）
export { ManualPage, type ManualPageProps } from "./components/ManualPage";
