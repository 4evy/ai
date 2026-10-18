export interface Signal<T extends unknown[] = []> {
  connect(callback: (...args: T) => void): void;
  disconnect(callback: (...args: T) => void): void;
}
export interface Desktop {
  id: string;
  x11DesktopNumber: number;
}
export interface Window {
  internalId: string;
  pid: number;
  minimized: boolean;
  minimizable: boolean;
  popupWindow: boolean;
  minimizedChanged: Signal;
  desktops: Desktop[];
  activities: string[];
  transientFor: Window | null;
  desktopsChanged: Signal;
  activitiesChanged: Signal;
  transientChanged: Signal;
  closed: Signal;
}
export interface Workspace {
  desktops: Desktop[];
  currentDesktop: Desktop;
  currentActivity: string;
  activeWindow: Window | null;
  windows: Window[];
  createDesktop(position: number, name: string): void;
  removeDesktop(desktop: Desktop): void;
  desktopsChanged: Signal;
}
export interface Bridge {
  available: boolean;
  scope(pid: number): string;
  retain(id: string): void;
  attach(id: string, pid: number): boolean;
  populated(id: string): boolean;
  forget(id: string): void;
  stop(id: string): void;
  windowCreated: Signal<[Window]>;
  windowMapped: Signal<[Window]>;
  ownerLost: Signal;
  handler: (operation: string, payload: string) => string;
}
