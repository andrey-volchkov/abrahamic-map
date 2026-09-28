import '@fontsource/cormorant-garamond/500.css';
import '@fontsource/cormorant-garamond/600.css';
import '@fontsource/cormorant-garamond/500-italic.css';
import '@fontsource/source-serif-4/400.css';
import '@fontsource/source-serif-4/400-italic.css';
import '@fontsource/ibm-plex-sans/400.css';
import '@fontsource/ibm-plex-sans/500.css';
import './style.css';
import { animCfg } from './ui/anim';
import { App } from './app';
import { viewFromSpec } from './engine/camera';

function webglOk() {
  try {
    const c = document.createElement('canvas');
    return !!c.getContext('webgl2');
  } catch {
    return false;
  }
}

if (!webglOk()) {
  document.getElementById('ui')!.innerHTML =
    '<div class="intro"><h1 style="font-size:48px">Нужен WebGL 2</h1><div class="sub">Откройте страницу в свежей версии Chrome, Firefox, Safari или Edge.</div></div>';
} else {
  const app = new App();
  app
    .boot()
    .catch((err) => {
      console.error(err);
      app.intro.progress(0, 'Не удалось загрузить данные карты. Обновите страницу.');
      throw err;
    })
    .then(() => {
    // debugging / screenshots: ?v={"lon":..,"lat":..,"dist":..}&year=..&chapter=..
    const q = new URLSearchParams(location.search);
    if (q.get('fast')) animCfg.scale = 0.02;
    if (q.get('step')) app.stage.fixedDt = +(q.get('step') as string);
    if (q.get('snap') || q.get('free') || q.get('chapter')) app.header.show(true);
    if (q.get('v')) app.stage.rig.set(viewFromSpec(JSON.parse(q.get('v') as string)));
    if (q.get('year')) app.setYear(+(q.get('year') as string));
    if (q.get('dbg')) app.stage.terrain.material.uniforms.uDebug.value = +(q.get('dbg') as string);
    if (q.get('snap')) {
      app.intro.hide();
      app.snapTo(+(q.get('snap') as string), +(q.get('frac') ?? 0.7));
      if (q.get('goto')) {
        app.setPlaying(true);
        app.go(+(q.get('goto') as string));
      }
    } else if (q.get('chapter')) {
      app.intro.hide();
      app.enterFilm(true);
      const i = +(q.get('chapter') as string);
      app.film.token++;
      app.film.i = i - 1;
      app.go(i);
    }
    if (q.get('free')) {
      app.intro.hide();
      app.enterFree();
    }
    if (q.get('sel')) app.select(q.get('sel') as string);
  });
}
