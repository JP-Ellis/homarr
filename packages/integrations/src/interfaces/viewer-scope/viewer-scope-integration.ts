export interface ViewerScopeUser {
  id: string;
  displayName: string;
  usernames: string[];
  email: string | null;
}

export interface IViewerScopeIntegration {
  listViewerScopeUsersAsync(): Promise<ViewerScopeUser[]>;
}

export const isViewerScopeIntegration = (integration: unknown): integration is IViewerScopeIntegration =>
  typeof integration === "object" &&
  integration !== null &&
  "listViewerScopeUsersAsync" in integration &&
  typeof integration.listViewerScopeUsersAsync === "function";
