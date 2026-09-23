import React, { useState } from "react";

const WelcomeAudioUnlock: React.FC<{ onAudioUnlocked?: (audioCtx: AudioContext) => void }> = ({ onAudioUnlocked }) => {
  const [visible, setVisible] = useState(true);

  const handleUnlockAudio = async () => {
    try {
      const audioCtx = new (window.AudioContext || (window as any).webkitAudioContext)();
      if (audioCtx.state === "suspended") {
        await audioCtx.resume();
      }

      // ----------------- sonido agradable -----------------
      const oscillator = audioCtx.createOscillator();
      const gainNode = audioCtx.createGain();

      oscillator.type = "sine";      // onda suave
      oscillator.frequency.value = 440; // tono A4, agradable
      gainNode.gain.value = 0.05;    // volumen bajito

      oscillator.connect(gainNode);
      gainNode.connect(audioCtx.destination);

      // pequeño fade-out
      const now = audioCtx.currentTime;
      gainNode.gain.setValueAtTime(0.05, now);
      gainNode.gain.exponentialRampToValueAtTime(0.001, now + 0.2); // fade-out 200ms

      oscillator.start(now);
      oscillator.stop(now + 0.2);

      // ---------------------------------------------------

      setVisible(false);
      if (onAudioUnlocked) onAudioUnlocked(audioCtx);

    } catch (err) {
      console.error("Error al desbloquear audio:", err);
    }
  };

  if (!visible) return null;

  return (
  <div style={containerStyle}>
  <h1 style={titleStyle}>Welcome!</h1>
  <p style={textStyle}>To enable audio, click the button below.</p>
  <button style={buttonStyle} onClick={handleUnlockAudio}>
    Enable Audio
  </button>
</div>
  );
};

// ---------- estilos ----------
const containerStyle: React.CSSProperties = {
  position: "fixed",
  top: 0,
  left: 0,
  width: "100vw",
  height: "100vh",
  display: "flex",
  flexDirection: "column",
  justifyContent: "center",
  alignItems: "center",
  backgroundColor: "rgba(0,0,0,0.6)",
  color: "white",
  zIndex: 9999,
};

const titleStyle: React.CSSProperties = {
  margin: 0,
  fontSize: "2rem",
};

const textStyle: React.CSSProperties = {
  marginTop: "1rem",
  fontSize: "1.2rem",
};

const buttonStyle: React.CSSProperties = {
  marginTop: 20,
  padding: "12px 24px",
  fontSize: 16,
  cursor: "pointer",
  border: "none",
  borderRadius: 8,
  backgroundColor: "#007bff",
  color: "white",
};

export default WelcomeAudioUnlock;
