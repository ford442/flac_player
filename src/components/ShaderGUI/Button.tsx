import React from 'react';
import './ShaderGUI.layout.css';

export type ButtonType = 'none' | 'ir' | 'stop' | 'play' | 'prev' | 'next';

interface ButtonProps {
  type: ButtonType;
  active: boolean;
  onClick: () => void;
}

interface ButtonConfig {
  label: string;
  /** Accessible name; the visible content is only a glyph. */
  name: string;
  /** Toggle buttons report `aria-pressed`. */
  toggle?: boolean;
  icon: string;
  color: string;
  ledColor: string;
}

const BUTTON_CONFIG: Record<ButtonType, ButtonConfig> = {
  none: { label: 'NONE', name: 'Visual mode: none', toggle: true, icon: '✕', color: '#4ADE80', ledColor: '#6B7280' },
  ir: { label: 'IR', name: 'Visual mode: IR', toggle: true, icon: '〰', color: '#F472B6', ledColor: '#F472B6' },
  stop: { label: 'STOP', name: 'Stop', icon: '■', color: '#F87171', ledColor: '#F87171' },
  play: { label: 'PLAY', name: 'Play', icon: '▶', color: '#4ADE80', ledColor: '#4ADE80' },
  prev: { label: 'PREV', name: 'Previous track', icon: '⏮', color: '#22D3EE', ledColor: '#22D3EE' },
  next: { label: 'NEXT', name: 'Next track', icon: '⏭', color: '#22D3EE', ledColor: '#22D3EE' },
};

export const Button: React.FC<ButtonProps> = ({ type, active, onClick }) => {
  const config = BUTTON_CONFIG[type];
  // PLAY lights while playing, so it reads as the pause control then.
  const name = type === 'play' && active ? 'Pause' : config.name;

  return (
    <button
      type="button"
      className="shader-button"
      onClick={onClick}
      title={config.label}
      aria-label={name}
      aria-pressed={config.toggle ? active : undefined}
      style={{
        color: active ? config.color : '#6B7280',
      }}
    >
      <span
        aria-hidden="true"
        className="button-icon"
        style={{
          color: active ? config.color : '#9CA3AF',
          filter: active ? `drop-shadow(0 0 6px ${config.ledColor})` : 'none',
        }}
      >
        {config.icon}
      </span>
      <span
        aria-hidden="true"
        className="button-led-glow"
        style={{
          backgroundColor: active ? config.ledColor : '#374151',
          opacity: active ? 1 : 0.3,
          boxShadow: active ? `0 0 8px 2px ${config.ledColor}` : 'none',
        }}
      />
    </button>
  );
};

export default Button;
