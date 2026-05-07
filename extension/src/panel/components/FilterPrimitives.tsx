import type { ReactNode } from 'react';

export function CollapsibleSection(props: {
  title: string;
  icon: string;
  count?: number;
  open: boolean;
  onToggle: () => void;
  children: ReactNode;
}) {
  return (
    <div className="sgc-filter-section">
      <button className="sgc-filter-section-header" onClick={props.onToggle}>
        <span className="sgc-filter-section-icon">{props.icon}</span>
        <span className="sgc-filter-section-title">{props.title}</span>
        {props.count != null && props.count > 0 && (
          <span className="sgc-filter-section-badge">{props.count}</span>
        )}
        <span className="sgc-filter-section-chevron">
          {props.open ? '▾' : '▸'}
        </span>
      </button>
      {props.open && (
        <div className="sgc-filter-section-body">{props.children}</div>
      )}
    </div>
  );
}

export function Chip(props: {
  label: string;
  count?: number;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      className={
        'sgc-filter-chip' + (props.active ? ' sgc-filter-chip-active' : '')
      }
      onClick={props.onClick}
    >
      <span>{props.label}</span>
      {props.count != null && (
        <span className="sgc-filter-chip-count">{props.count}</span>
      )}
    </button>
  );
}
