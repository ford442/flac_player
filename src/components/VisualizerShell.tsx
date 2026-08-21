import React, { useCallback, useEffect, useState } from 'react';
import { ShaderGUI, ShaderGUIProps } from './ShaderGUI/ShaderGUI';
import { ProjectMHost } from './ProjectMHost';
import { useBeatDetection } from '../hooks/useBeatDetection';
import {
  AESTHETIC_LABELS,
  VisualizerAesthetic,
  persistVisualizerAesthetic,
  shouldLimitShaderGpu,
} from '../utils/visualizerMode';
import './VisualizerShell.css';

export interface VisualizerShellProps extends ShaderGUIProps {
  aesthetic: VisualizerAesthetic;
  onAestheticChange: (mode: VisualizerAesthetic) => void;
}

export const VisualizerShell: React.FC<VisualizerShellProps> = ({
  aesthetic,
  onAestheticChange,
  analyser,
  ...shaderProps
}) => {
  const [beatSync, setBeatSync] = useState(false);
  const [projectmFailed, setProjectmFailed] = useState(false);
  const { beatPhaseRef, processFrame } = useBeatDetection();
  const [beatPhase, setBeatPhase] = useState(0);

  useEffect(() => {
    if (aesthetic === 'shadergui') return;
    let raf = 0;
    const tick = () => {
      processFrame(analyser);
      setBeatPhase(beatPhaseRef.current);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [aesthetic, analyser, beatPhaseRef, processFrame]);

  const effectiveAesthetic: VisualizerAesthetic =
    projectmFailed && aesthetic !== 'shadergui' ? 'shadergui' : aesthetic;

  const setAesthetic = useCallback((mode: VisualizerAesthetic) => {
    persistVisualizerAesthetic(mode);
    onAestheticChange(mode);
  }, [onAestheticChange]);

  const showShader = true;
  const showProjectM = effectiveAesthetic !== 'shadergui';
  const limitGpu = shouldLimitShaderGpu(effectiveAesthetic);
  const controlsOnly = effectiveAesthetic === 'projectm';

  return (
    <div className={`visualizer-shell visualizer-shell--${effectiveAesthetic}`}>
      <div className="visualizer-shell__aesthetic-bar">
        <span className="visualizer-shell__label">Visualizer</span>
        {(Object.keys(AESTHETIC_LABELS) as VisualizerAesthetic[]).map((key) => (
          <button
            key={key}
            type="button"
            className={`visualizer-shell__aesthetic-btn${effectiveAesthetic === key ? ' is-active' : ''}`}
            onClick={() => setAesthetic(key)}
          >
            {AESTHETIC_LABELS[key]}
          </button>
        ))}
        {projectmFailed && aesthetic !== 'shadergui' && (
          <span className="visualizer-shell__fallback-note">projectM unavailable — ShaderGUI fallback</span>
        )}
      </div>

      {effectiveAesthetic === 'projectm' && showProjectM && (
        <div className="visualizer-shell__projectm">
          <ProjectMHost
            beatPhase={beatPhase}
            beatSyncPresets={beatSync}
            onFailed={() => setProjectmFailed(true)}
          />
          <label className="visualizer-shell__beat-toggle">
            <input
              type="checkbox"
              checked={beatSync}
              onChange={(e) => setBeatSync(e.target.checked)}
            />
            Beat-sync presets
          </label>
        </div>
      )}

      {showShader && (
        <div className={`visualizer-shell__shader${limitGpu ? ' visualizer-shell__shader--lite' : ''}`}>
          <ShaderGUI
            {...shaderProps}
            analyser={analyser}
            controlsOnly={controlsOnly}
          />
        </div>
      )}

      {effectiveAesthetic === 'split' && showProjectM && (
        <div className="visualizer-shell__projectm">
          <ProjectMHost
            beatPhase={beatPhase}
            beatSyncPresets={beatSync}
            onFailed={() => setProjectmFailed(true)}
          />
          <label className="visualizer-shell__beat-toggle">
            <input
              type="checkbox"
              checked={beatSync}
              onChange={(e) => setBeatSync(e.target.checked)}
            />
            Beat-sync presets
          </label>
        </div>
      )}
    </div>
  );
};

export default VisualizerShell;
