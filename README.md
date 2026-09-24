# Weltkarte für den Lagebericht

## Dateien
- `world.svg` – Übersichtskarte, Auflösung 110 m, ca. 160 KB. Standard für Study OS (Desktop und Handy).
- `world-detail.svg` – Auflösung 50 m, ca. 1,1 MB. Nur laden, wenn beim Hineinzoomen mehr Details nötig sind. Nicht fest ins HTML einbetten.
- `laendernamen.json` – Zuordnung Ländercode (ISO-3166 alpha-3) zu deutschem Namen, 174 Einträge.

## Herkunft und Lizenz
Natural Earth über das npm-Paket `world-atlas` (Version 2). Natural Earth ist gemeinfrei (public domain), es braucht keine Namensnennung.
Projektion: Natural Earth 1. ViewBox `0 0 1000 520`, skaliert über `width: 100%`.

## Aufbau
Jedes Land ist ein eigener Pfad:

```html
<path id="CHE" data-iso="CHE" class="c" d="…"><title>Schweiz</title></path>
```

- `id` und `data-iso` sind der ISO-alpha-3-Code.
- `<title>` liefert den Tooltip im Browser.
- Die Klassen und Farben stehen als `<style>` direkt im SVG und lassen sich überschreiben.

## Verwendung
SVG direkt ins HTML einfügen (nicht als `<img>`, sonst sind die Länder nicht anklickbar):

```js
// Lage-Level setzen
document.getElementById('RUS').classList.add('lvl-akut');

// Klick auf ein Land öffnet das Dossier
document.querySelectorAll('.worldmap .c').forEach(el => {
  el.addEventListener('click', () => oeffneDossier(el.dataset.iso));
});
```

Verfügbare Klassen: `lvl-ruhig`, `lvl-beobachten`, `lvl-erhoeht`, `lvl-angespannt`, `lvl-akut`, dazu `sel` für das aktuell gewählte Land.

## Hinweise
- Farben an das aktive Theme koppeln: die Variablen `--sea`, `--land`, `--border`, `--hl` auf `.worldmap` überschreiben.
- Markierungen (Punkte pro Land) als eigene `<circle>`-Elemente über die Karte legen. Die Position pro Land einmalig als Koordinatenpaar in der Lagebericht-Datenstruktur hinterlegen, statt sie aus dem Pfad zu berechnen.
- Kosovo hat in Natural Earth keinen ISO-Code und daher keine `id`. Falls nötig, den Pfad manuell mit `id="XKX"` ergänzen.
- Kleinstaaten (Monaco, Liechtenstein, Singapur) sind bei 110 m kaum sichtbar. Für sie am besten immer eine Markierung setzen.
