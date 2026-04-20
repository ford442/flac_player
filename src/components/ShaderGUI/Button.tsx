import React from 'react';
import './ShaderGUI.css';

export type ButtonType = 'none' | 'ir' | 'stop' | 'play' | 'prev' | 'next';

interface ButtonProps {
  type: ButtonType;
  active: boolean;
  onClick: () => void;
}

const BUTTON_CONFIG: Record<ButtonType, { label: string; icon: string; color: string; ledColor: string }> = {
  none: { label: 'NONE', icon: '✕', color: '#4ADE80', ledColor: '#6B7280' },
  ir: { label: 'IR', icon: '〰', color: '#F472B6', ledColor: '#F472B6' },
  stop: { label: 'STOP', icon: '■', color: '#F87171', ledColor: '#F87171' },
  play: { label: 'PLAY', icon: '▶', color: '#4ADE80', ledColor: '#4ADE80' },
  prev: { label: 'PREV', icon: '⏮', color: '#22D3EE', ledColor: '#22D3EE' },
  next: { label: 'NEXT', icon: '⏭', color: '#22D3EE', ledColor: '#22D3EE' },
};

export const Button: React.FC<ButtonProps> = ({ type, active, onClick }) => {
  const config = BUTTON_CONFIG[type];

  return (
    <button
      className="shader-button"
      onClick={onClick}
      title={config.label}
      style={{
        color: active ? config.color : '#6B7280',
      }}
    >
      <span
        className="button-icon"
        style={{
          color: active ? config.color : '#9CA3AF',
          filter: active ? `drop-shadow(0 0 6px ${config.ledColor})` : 'none',
        }}
      >
        {config.icon}
      </span>
      <span
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
