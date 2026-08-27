export class FigureFollowState {
  private figureIds = new Set<string>();
  private selectedId?: string;
  private readingTargetId?: string;
  private pendingNavigationId?: string;
  private following = true;

  setFigures(ids: string[]): void {
    this.figureIds = new Set(ids);
    if (!this.selectedId || !this.figureIds.has(this.selectedId)) this.selectedId = ids[0];
    if (!this.readingTargetId || !this.figureIds.has(this.readingTargetId)) this.readingTargetId = ids[0];
    if (this.pendingNavigationId && !this.figureIds.has(this.pendingNavigationId)) this.pendingNavigationId = undefined;
    if (this.following && this.readingTargetId) this.selectedId = this.readingTargetId;
  }

  select(id: string): boolean {
    if (!this.figureIds.has(id) || this.selectedId === id) return false;
    this.selectedId = id;
    return true;
  }

  selectForNavigation(id: string): boolean {
    if (!this.figureIds.has(id)) return false;
    const pendingChanged = this.following && this.pendingNavigationId !== id;
    this.pendingNavigationId = this.following ? id : undefined;
    const selectionChanged = this.selectedId !== id;
    this.selectedId = id;
    return pendingChanged || selectionChanged;
  }

  trackReadingTarget(id: string): boolean {
    if (!this.figureIds.has(id)) return false;
    const targetChanged = this.readingTargetId !== id;
    this.readingTargetId = id;
    if (this.following && this.pendingNavigationId) {
      if (id !== this.pendingNavigationId) return targetChanged;
      this.pendingNavigationId = undefined;
    }
    const selectionChanged = this.following && this.selectedId !== id;
    if (this.following) this.selectedId = id;
    return targetChanged || selectionChanged;
  }

  setFollowing(value: boolean): boolean {
    const followChanged = this.following !== value;
    const selectionChanged = value && Boolean(this.readingTargetId) && this.selectedId !== this.readingTargetId;
    this.following = value;
    this.pendingNavigationId = undefined;
    if (value && this.readingTargetId) this.selectedId = this.readingTargetId;
    return followChanged || selectionChanged;
  }

  cancelPendingNavigation(): boolean {
    if (!this.pendingNavigationId) return false;
    this.pendingNavigationId = undefined;
    const selectionChanged = this.following
      && Boolean(this.readingTargetId)
      && this.selectedId !== this.readingTargetId;
    if (selectionChanged) this.selectedId = this.readingTargetId;
    return true;
  }

  get selected(): string | undefined {
    return this.selectedId;
  }

  get readingTarget(): string | undefined {
    return this.readingTargetId;
  }

  get isFollowing(): boolean {
    return this.following;
  }
}
