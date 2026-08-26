export const PDF_MIN_ZOOM = 0.4;
export const PDF_MAX_ZOOM = 4;

function finite(value: number, fallback: number): number {
  return Number.isFinite(value) ? value : fallback;
}

export class PdfReaderState {
  private total = 0;
  private page = 1;
  private scale = 1;

  setPageCount(value: number): boolean {
    const next = Math.max(0, Math.floor(finite(value, 0)));
    const changed = next !== this.total;
    this.total = next;
    this.page = this.clampPage(this.page);
    return changed;
  }

  setPage(value: number): boolean {
    const next = this.clampPage(value);
    if (next === this.page) return false;
    this.page = next;
    return true;
  }

  changePage(delta: number): boolean {
    return this.setPage(this.page + Math.trunc(finite(delta, 0)));
  }

  setZoom(value: number): boolean {
    const next = Math.max(PDF_MIN_ZOOM, Math.min(PDF_MAX_ZOOM, finite(value, 1)));
    if (Math.abs(next - this.scale) < 0.0001) return false;
    this.scale = next;
    return true;
  }

  changeZoom(factor: number): boolean {
    return this.setZoom(this.scale * finite(factor, 1));
  }

  get currentPage(): number {
    return this.page;
  }

  get pageCount(): number {
    return this.total;
  }

  get zoom(): number {
    return this.scale;
  }

  private clampPage(value: number): number {
    const maximum = Math.max(1, this.total);
    return Math.max(1, Math.min(maximum, Math.floor(finite(value, 1))));
  }
}
