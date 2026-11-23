// QR pictures and the camera scanner. Covered: browsers with BarcodeDetector (Chrome / Edge / Android) use it; every other browser with a camera (Safari, Firefox) uses the
// bundled `jsqr` reader on frames of the same camera stream. A browser with no camera access, or a person who said no, gets a clear message and the typed code instead.
import { useEffect, useRef, useState } from 'react';
import { useI18n } from './i18n';
import { Icon } from './icons';
import { qrSvg } from './e2ee/qr';

export function QrImage({ text, label }: { text: string; label: string }) {
  const svg = qrSvg(text);
  // the picture is black on white with its own quiet border, so it stays readable in dark mode
  return <div role="img" aria-label={label} className="mx-auto w-52 h-52 rounded-2xl border border-line elevated-1 bg-white p-0 overflow-hidden [&>svg]:w-full [&>svg]:h-full" dangerouslySetInnerHTML={{ __html: svg }} />;
}

type ScanProblem = 'denied' | 'none' | 'unsupported';

/** Opens the camera and calls `onText` ONCE with the first QR text it reads. `onClose` when the person cancels. */
export function QrScanner({ onText, onClose }: { onText: (text: string) => void; onClose: () => void }) {
  const { t } = useI18n();
  const video = useRef<HTMLVideoElement>(null);
  const [problem, setProblem] = useState<ScanProblem | null>(null);
  useEffect(() => {
    let live = true, stream: MediaStream | null = null, timer = 0, done = false;
    (async () => {
      if (!navigator.mediaDevices?.getUserMedia) { setProblem('unsupported'); return; }
      try { stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' } }, audio: false }); }
      catch (e: any) { if (live) setProblem(e?.name === 'NotAllowedError' || e?.name === 'SecurityError' ? 'denied' : 'none'); return; }
      if (!live) { stream.getTracks().forEach(x => x.stop()); return; }
      const v = video.current!;
      v.srcObject = stream; v.setAttribute('playsinline', 'true'); await v.play().catch(() => undefined);
      const Detector = (window as any).BarcodeDetector;
      const detector = Detector ? new Detector({ formats: ['qr_code'] }) : null;
      const canvas = document.createElement('canvas');
      const jsqr = detector ? null : (await import('jsqr')).default;
      const tick = async () => {
        if (!live || done) return;
        try {
          if (v.readyState >= 2 && v.videoWidth) {
            let text: string | null = null;
            if (detector) text = (await detector.detect(v))[0]?.rawValue ?? null;
            else {
              const w = Math.min(640, v.videoWidth), h = Math.round(v.videoHeight * w / v.videoWidth);
              canvas.width = w; canvas.height = h;
              const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
              ctx.drawImage(v, 0, 0, w, h);
              text = jsqr!(ctx.getImageData(0, 0, w, h).data, w, h)?.data ?? null;
            }
            if (text) { done = true; onText(text); return; }
          }
        } catch { /* a frame that cannot be read: try the next */ }
        timer = window.setTimeout(tick, 250);
      };
      tick();
    })();
    return () => { live = false; clearTimeout(timer); stream?.getTracks().forEach(x => x.stop()); };
  }, []);   // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <div className="mt-2">
      {problem ? <p role="alert" className="flex items-start gap-2 rounded-xl bg-gold/15 text-ink text-sm px-3 py-2"><Icon name="alert" className="w-4 h-4 shrink-0 text-danger mt-0.5" /><span>{problem === 'denied' ? t.e2ee.scanDenied : problem === 'none' ? t.e2ee.scanNone : t.e2ee.scanUnsupported}</span></p>
        : <video ref={video} muted className="block w-full max-w-xs mx-auto rounded-2xl border border-line elevated-1 bg-black aspect-square object-cover animate-fade-in" aria-label={t.e2ee.scanning} />}
      {!problem && <p className="text-xs text-muted text-center mt-2 flex items-center justify-center gap-1.5"><Icon name="qr" className="w-3.5 h-3.5 shrink-0" />{t.e2ee.scanning}</p>}
      <button className="btn btn-ghost w-full mt-2" onClick={onClose}>{t.e2ee.scanCancel}</button>
    </div>
  );
}
