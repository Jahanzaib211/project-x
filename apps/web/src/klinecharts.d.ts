/**
 * The vendored chart library's global, as the page uses it.
 *
 * Only the surface this app touches is typed. The library ships full types in
 * its npm package; they are not vendored, because a declaration this small is
 * easier to keep true than a 1 200-line file that must match the pinned build.
 */
export interface Bar { timestamp: number; open: number; high: number; low: number; close: number; volume?: number }
export interface Chart {
  setStyles(styles: string | Record<string, unknown>): void;
  setSymbol(symbol: { ticker: string; pricePrecision: number; volumePrecision: number }): void;
  setPeriod(period: { type: string; span: number }): void;
  setDataLoader(loader: {
    getBars: (params: { type: string; timestamp: number | null; callback: (bars: unknown[], more?: unknown) => void }) => void | Promise<void>;
    subscribeBar?: (params: { callback: (bar: Bar) => void }) => void;
    unsubscribeBar?: () => void;
  }): void;
  createIndicator(value: string | Record<string, unknown>, isStack?: boolean): string | null;
  removeIndicator(filter?: { id?: string; name?: string; paneId?: string }): boolean;
  getIndicators(filter?: { id?: string; name?: string; paneId?: string }): Array<{ id: string; name: string; paneId: string }>;
  setPaneOptions(options: { id: string; height?: number; minHeight?: number; dragEnabled?: boolean }): void;
  createOverlay(value: string | Record<string, unknown>): string | null | Array<string | null>;
  removeOverlay(filter?: { id?: string; name?: string }): boolean;
  getOverlays(filter?: { id?: string; name?: string }): Array<{ id: string; name: string }>;
  resize(): void;
}
export function init(element: HTMLElement | string, options?: Record<string, unknown>): Chart | null;
export function dispose(element: HTMLElement | Chart | string): void;
export function version(): string;
