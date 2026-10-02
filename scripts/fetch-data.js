#!/usr/bin/env node
/**
 * fetch-data.js — Collecte les données S5 Fourmizzz et génère les JSON statiques
 * Lancé par le GitHub Action chaque nuit à 23h15 UTC
 */

const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');

const BASE_URL = 'https://s5.fourmizzz.fr';
const PUBLIC_DATA = path.join(__dirname, '..', 'public', 'data');
const HISTORY_FILE = path.join(PUBLIC_DATA, 'history.json');

// ── Helpers ──────────────────────────────────────────────────────────────────

function fetchJSON(url) {
  return new Promise((resolve, reject) => {
    const client = url.startsWith('https') ? https : http;
    client.get(url, (res) => {
      if (res.statusCode === 502 || res.statusCode === 503) {
        reject(new Error(`SERVEUR_INDISPONIBLE:${res.statusCode}`));
        return;
      }
      if (res.statusCode !== 200) {
        reject(new Error(`HTTP ${res.statusCode} pour ${url}`));
        return;
      }
      let raw = '';
      res.on('data', chunk => raw += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(raw)); }
        catch (e) { reject(new Error(`JSON parse error: ${e.message}`)); }
      });
    }).on('error', reject);
  });
}

function readJSON(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch { return fallback; }
}

function writeJSON(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data), 'utf8');
  console.log(`  ✓ ${path.relative(PUBLIC_DATA, file)}`);
}

// ── Calculs ──────────────────────────────────────────────────────────────────

function computeRanks(players) {
  const byField  = [...players].sort((a, b) => b.field - a.field);
  const byBuild  = [...players].sort((a, b) => b.buildingScore - a.buildingScore);
  const byTech   = [...players].sort((a, b) => b.technologyScore - a.technologyScore);
  const byTrophy = [...players].sort((a, b) => b.trophyScore - a.trophyScore);

  const ranks = {};
  byField.forEach((p, i)  => { ranks[p.id] = {}; ranks[p.id].field   = i + 1; });
  byBuild.forEach((p, i)  => { ranks[p.id].build   = i + 1; });
  byTech.forEach((p, i)   => { ranks[p.id].tech    = i + 1; });
  byTrophy.forEach((p, i) => { ranks[p.id].trophy  = i + 1; });
  return ranks;
}

function computeStats(players, alliances) {
  const active       = players.filter(p => p.buildingScore > 0);
  const withAlliance = players.filter(p => p.alliance !== null);
  const onHoliday    = players.filter(p => p.onHoliday);
  const colonised    = players.filter(p => p.masterPlayerId !== null);
  const totalField   = players.reduce((s, p) => s + p.field, 0);

  return {
    players:      players.length,
    active:       active.length,
    withAlliance: withAlliance.length,
    alliances:    alliances.length,
    onHoliday:    onHoliday.length,
    colonised:    colonised.length,
    totalField,
    avgField:     Math.round(totalField / players.length),
    maxField:     Math.max(...players.map(p => p.field)),
    maxBuild:     Math.max(...players.map(p => p.buildingScore)),
    maxTech:      Math.max(...players.map(p => p.technologyScore)),
  };
}

function versionToDate(version) {
  const y = version.slice(0, 4);
  const m = version.slice(4, 6);
  const d = version.slice(6, 8);
  return `${d}/${m}/${y}`;
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log('=== Fourmizzz S5 — collecte données ===');

  // 1. Lister les versions disponibles
  const versions = await fetchJSON(`${BASE_URL}/api/exports/`);
  if (!versions.players || versions.players.length === 0) {
    console.log('Aucune version disponible.');
    return;
  }
  const lastVersion = versions.players[0];
  console.log(`Version export : ${lastVersion}`);

  // Vérifier si déjà traité
  const history = readJSON(HISTORY_FILE, []);
  if (history.length > 0 && history[0].version === lastVersion) {
    console.log('Déjà à jour, rien à faire.');
    return;
  }

  // 2. Récupérer joueurs et alliances
  console.log('Récupération joueurs…');
  const players = await fetchJSON(`${BASE_URL}/api/exports/players/`);
  console.log(`  ${players.length} joueurs`);

  console.log('Récupération alliances…');
  const alliances = await fetchJSON(`${BASE_URL}/api/exports/alliances/`);
  console.log(`  ${alliances.length} alliances`);

  // 3. Calculer rangs et stats globales
  const ranks = computeRanks(players);
  const stats  = computeStats(players, alliances);

  // 4. Enrichir joueurs avec leurs rangs
  const enriched = players.map(p => ({
    ...p,
    rankField:  ranks[p.id].field,
    rankBuild:  ranks[p.id].build,
    rankTech:   ranks[p.id].tech,
    rankTrophy: ranks[p.id].trophy,
  }));

  // 5. Calculer les deltas par rapport à j-1
  const prevFile    = path.join(PUBLIC_DATA, 'players_prev.json');
  const prevPlayers = readJSON(prevFile, []);
  const prevMap     = {};
  prevPlayers.forEach(p => { prevMap[p.id] = p; });

  const withDelta = enriched.map(p => {
    const prev = prevMap[p.id];
    return {
      ...p,
      deltaField:      prev != null ? p.field - prev.field : null,
      deltaBuild:      prev != null ? p.buildingScore - prev.buildingScore : null,
      deltaRankField:  prev != null ? (prev.rankField || p.rankField) - p.rankField : null,
    };
  });

  // 6. Écrire les fichiers statiques
  console.log('Écriture fichiers :');
  const dateStr = versionToDate(lastVersion);

  writeJSON(path.join(PUBLIC_DATA, 'players.json'),  withDelta);
  writeJSON(path.join(PUBLIC_DATA, 'alliances.json'), alliances);
  writeJSON(path.join(PUBLIC_DATA, 'stats.json'), {
    ...stats,
    version: lastVersion,
    date:    dateStr,
  });

  // 7. Historique sur 30 jours max
  history.unshift({
    version:   lastVersion,
    date:      dateStr,
    players:   stats.players,
    active:    stats.active,
    alliances: stats.alliances,
    maxField:  stats.maxField,
    maxBuild:  stats.maxBuild,
  });
  if (history.length > 30) history.splice(30);
  writeJSON(HISTORY_FILE, history);

  // 8. Sauvegarder l'état actuel pour calculer les deltas demain
  writeJSON(prevFile, enriched);

  console.log('=== Terminé ===');
}

main().catch(err => {
  if (err.message.startsWith('SERVEUR_INDISPONIBLE')) {
    // L'API Fourmizzz est temporairement down (502/503)
    // Si des données locales existent, on sort proprement — le déploiement utilisera ces données
    const hasData = fs.existsSync(path.join(PUBLIC_DATA, 'players.json'));
    if (hasData) {
      console.warn(`⚠️  API indisponible (${err.message}) — données existantes conservées, déploiement normal.`);
      process.exit(0);
    }
    console.error(`ERREUR: API indisponible et aucune donnée locale — ${err.message}`);
    process.exit(1);
  }
  console.error('ERREUR:', err.message);
  process.exit(1);
});
