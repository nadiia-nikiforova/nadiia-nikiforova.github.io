/* The story game opens over the page, on a dark stage of its own, instead of
   taking the visitor away from the portfolio. Closing it (the button or Esc)
   puts them back exactly where they were. Without JavaScript the card link
   simply opens the game page. */
(() => {
  const link = document.querySelector('a[data-story]');
  if (!link) return;
  let stage = null;

  function close() {
    if (!stage) return;
    stage.remove();
    stage = null;
    document.documentElement.classList.remove('is-playing');
    document.removeEventListener('keydown', onKey);
    link.focus({ preventScroll: true });   // back to the card, without jumping the page
  }

  function onKey(e) {
    if (e.key === 'Escape') close();
  }

  function open(e) {
    e.preventDefault();
    if (stage) return;
    stage = document.createElement('div');
    stage.className = 'story-stage';
    stage.setAttribute('role', 'dialog');
    stage.setAttribute('aria-modal', 'true');
    stage.setAttribute('aria-label', link.textContent.trim());

    const shut = document.createElement('button');
    shut.className = 'story-stage__close';
    shut.type = 'button';
    shut.setAttribute('aria-label', 'Close the game');
    shut.innerHTML = '<span aria-hidden="true">✕</span><span class="story-stage__label" aria-hidden="true">Close</span>';
    shut.addEventListener('click', close);

    const game = document.createElement('iframe');
    game.className = 'story-stage__game';
    game.title = link.textContent.trim();
    game.src = link.href;
    game.classList.add('is-loading');   // hidden until the drive has started
    game.addEventListener('load', () => {
      const win = game.contentWindow;
      // The game's end screen links back to the work. Inside the stage that
      // should close the game and scroll this page, not load a page inside it.
      if (!win.location.pathname.endsWith('/story/drive.html')) {
        const hash = win.location.hash;
        close();
        if (hash) location.hash = hash;
        return;
      }
      // Clicking the card already said "play", so skip the game's own title
      // screen and its Play button: start the drive and only then show it.
      win.document.getElementById('play')?.click();
      game.classList.remove('is-loading');
      // Keys pressed while playing land in the game, so listen there for Esc too.
      win.addEventListener('keydown', onKey);
      win.focus();
    });

    const bar = document.createElement('div');
    bar.className = 'story-stage__bar';
    bar.append(shut);
    stage.append(bar, game);
    document.body.append(stage);
    document.documentElement.classList.add('is-playing');
    document.addEventListener('keydown', onKey);
  }

  link.addEventListener('click', open);
})();
