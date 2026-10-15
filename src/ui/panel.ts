// Contract every window module implements.
export interface PanelDef {
  body: HTMLElement;
  headerExtra?: HTMLElement;
  onResize?: () => void;
  onShow?: () => void;
  onHide?: () => void;
}
