import React from 'react';
import './ShaderGUI.css';

interface ChassisProps {
  children: React.ReactNode;
}

export const Chassis: React.FC<ChassisProps> = ({ children }) => {
  return (
    <div className="shader-gui-chassis">
      <div className="shader-gui-canvas-container" style={{ position: 'relative' }}>
        {children}
      </div>
      <div className="vent-grill" style={{ justifyContent: 'center', marginTop: 12 }}>
        {Array.from({ length: 12 }).map((_, i) => (
          <div key={i} className="vent-slit" />
        ))}
      </div>
    </div>
  );
};

export default Chassis;
