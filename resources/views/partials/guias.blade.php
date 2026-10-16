{{-- Guías: tarjeta que señala partes de la pantalla (#tour) y menú de guías del lugar (#guide-menu). Lo maneja resources/js/guides/guide.js. --}}
<div id="tour" class="tour" role="dialog" aria-modal="false" aria-labelledby="tour-title" aria-describedby="tour-text" tabindex="-1" hidden>
    <p id="tour-count" class="tour-count"></p>
    <h2 id="tour-title"></h2>
    <p id="tour-text"></p>
    <div class="tour-actions">
        <button id="tour-skip" type="button" class="link">Saltar</button>
        <span class="tour-spacer"></span>
        <button id="tour-prev" type="button">Atrás</button>
        <button id="tour-next" type="button" class="primary">Siguiente</button>
    </div>
</div>

<div id="guide-menu" class="overlay" hidden>
    <section class="dialog guide-menu" role="dialog" aria-modal="true" aria-labelledby="guide-menu-title" tabindex="-1">
        <h2 id="guide-menu-title">Guías</h2>
        <p id="guide-menu-place" class="guide-menu-place"></p>
        <ul id="guide-menu-list" class="guide-menu-list"></ul>
        <div class="dialog-actions">
            <button id="guide-menu-close" type="button">Cerrar</button>
        </div>
    </section>
</div>
