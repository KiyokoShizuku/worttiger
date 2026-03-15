const SUPABASE_URL = "https://flzogatrbhkjagiayvlj.supabase.co";
const SUPABASE_KEY = "sb_publishable_sgjK1s6GMpNYidrD9aICyA_cxYhiDSI";

const sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY);
const ATTEMPTS = 6;
const WORD_SEQUENCE = [7, 6, 5, 4];
const MAX_POINTS_PER_WORD = 500;
const POINTS_LOST_PER_ATTEMPT = 100;
const HISTORY_LIMIT = 10;

const WORD_FILES = {
  4: ["data/words-4.json", "data/extra-4.json"],
  5: ["data/words-5.json", "data/extra-5.json"],
  6: ["data/words-6.json", "data/extra-6.json"],
  7: ["data/words-7.json", "data/extra-7.json"],
};

const KEYBOARD_ROWS = [
  ["q", "w", "e", "r", "t", "z", "u", "i", "o", "p", "ü"],
  ["a", "s", "d", "f", "g", "h", "j", "k", "l", "ö", "ä"],
  ["enter", "y", "x", "c", "v", "b", "n", "m", "backspace"],
];

const STATE_RANK = {
  unknown: 0,
  absent: 1,
  present: 2,
  correct: 3,
};

let WORDS = null;
let timerInterval = null;
let revealTimeouts = [];

const appState = {
  gameNumber: 1,
  sequenceIndex: 0,
  solutions: {},
  boards: {},
  keyboard: {},
  isAwaitingContinue: false,
  isRevealing: false,
  revealState: null,
  activeWordStartedAt: null,
  gameStartedAt: null,
  currentWordCompletedAt: null,
  completedWords: [],
  gameFinished: false,
  gameHistory: [],
  viewingLength: null,
  cursorIndex: 0,
  currentUser: null,
  userStats: {
    currentStreak: 0,
    bestStreak: 0,
  },
};

function normalize(word) {
  return String(word || "").toLowerCase().trim();
}

function normalizeChar(char) {
  return normalize(char).slice(0, 1);
}

function charLength(word) {
  return [...String(word || "")].length;
}

function nowMs() {
  return Date.now();
}

function msToClock(ms) {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const minutes = String(Math.floor(totalSeconds / 60)).padStart(2, "0");
  const seconds = String(totalSeconds % 60).padStart(2, "0");
  return `${minutes}:${seconds}`;
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function setStatus(message, emphasis = "") {
  const status = document.getElementById("status");
  if (emphasis) {
    status.innerHTML = `
      <div class="status-emphasis">${escapeHtml(emphasis)}</div>
      <div class="status-message">${escapeHtml(message)}</div>
    `;
    return;
  }

  status.innerHTML = `<div class="status-message">${escapeHtml(message)}</div>`;
}
function setInvalidWordStatus(word) {
  const status = document.getElementById("status");
  status.innerHTML = `
    <div class="status-message">
      <span class="status-bad-word">„${escapeHtml(word)}“</span>&nbsp;ist nicht in der Wortliste.
    </div>
  `;
}
function randomChoice(items) {
  return items[Math.floor(Math.random() * items.length)];
}

function displayChar(char) {
  if (!char) return "";
  if (char === "ß") return "ẞ";
  return char.toLocaleUpperCase("de-DE");
}

function displayWord(word) {
  return [...String(word || "")].map(displayChar).join("");
}

function createEmptyBoard(length) {
  return {
    length,
    currentTiles: Array(length).fill(""),
    guesses: [],
    evaluations: [],
    solved: false,
    failed: false,
    stats: null,
  };
}

function normalizeLoadedBoard(rawBoard, length) {
  const board = {
    length,
    currentTiles: Array(length).fill(""),
    guesses: Array.isArray(rawBoard?.guesses) ? rawBoard.guesses.map(normalize) : [],
    evaluations: Array.isArray(rawBoard?.evaluations) ? rawBoard.evaluations : [],
    solved: Boolean(rawBoard?.solved),
    failed: Boolean(rawBoard?.failed),
    stats: rawBoard?.stats || null,
  };

  if (Array.isArray(rawBoard?.currentTiles)) {
    board.currentTiles = rawBoard.currentTiles
      .slice(0, length)
      .map((char) => normalizeChar(char));

    while (board.currentTiles.length < length) {
      board.currentTiles.push("");
    }

    return board;
  }

  if (typeof rawBoard?.currentGuess === "string") {
    const chars = [...normalize(rawBoard.currentGuess)].slice(0, length);
    chars.forEach((char, index) => {
      board.currentTiles[index] = char;
    });
  }

  return board;
}

function getCurrentLength() {
  return WORD_SEQUENCE[appState.sequenceIndex];
}

function getCurrentBoard() {
  return appState.boards[getCurrentLength()];
}

function getViewedLength() {
  return appState.viewingLength || getCurrentLength();
}

function getViewedBoard() {
  return appState.boards[getViewedLength()];
}

function isViewingCurrentBoard() {
  return getViewedLength() === getCurrentLength();
}

function currentGuessString(board = getCurrentBoard()) {
  return board.currentTiles.join("");
}

function isCurrentGuessComplete(board = getCurrentBoard()) {
  return board.currentTiles.every((char) => char !== "");
}

function syncCursorIndex() {
  const board = getCurrentBoard();
  if (!board) {
    appState.cursorIndex = 0;
    return;
  }

  if (appState.cursorIndex < 0) appState.cursorIndex = 0;
  if (appState.cursorIndex > board.length) appState.cursorIndex = board.length;
}

function setCursorIndex(index) {
  const board = getCurrentBoard();
  if (!board || !isViewingCurrentBoard() || appState.isRevealing) return;
  appState.cursorIndex = Math.max(0, Math.min(index, board.length));
  render();
}

function openBoard(length) {
  if (!appState.boards[length]) return;
  appState.viewingLength = length;

  if (length === getCurrentLength()) {
    setStatus(`Aktives Wort geöffnet: ${length} Buchstaben.`);
  } else {
    setStatus(`Verlauf geöffnet: ${length} Buchstaben. Zum Weiterspielen wieder das aktuelle Wort anklicken.`);
  }

  render();
}

function updateTimers() {
  const now = nowMs();
  const wordElapsed = appState.activeWordStartedAt ? now - appState.activeWordStartedAt : 0;
  const gameElapsed = appState.gameStartedAt ? now - appState.gameStartedAt : 0;

  document.getElementById("wordTimer").textContent = msToClock(wordElapsed);
  document.getElementById("gameTimer").textContent = msToClock(gameElapsed);
  document.getElementById("totalPoints").textContent = String(
    appState.completedWords.reduce((sum, item) => sum + item.points, 0)
  );
}

function startTimerLoop() {
  stopTimerLoop();
  timerInterval = setInterval(updateTimers, 250);
}

function stopTimerLoop() {
  if (timerInterval) {
    clearInterval(timerInterval);
    timerInterval = null;
  }
}

function clearRevealTimers() {
  for (const timeoutId of revealTimeouts) {
    clearTimeout(timeoutId);
  }
  revealTimeouts = [];
  appState.isRevealing = false;
  appState.revealState = null;
}

async function fetchWordFile(file) {
  const response = await fetch(file);

  if (!response.ok) {
    if (file.includes("extra-") && response.status === 404) {
      return [];
    }
    throw new Error(`Konnte ${file} nicht laden.`);
  }

  return response.json();
}

async function loadWordLists() {
  const loaded = {};

  for (const length of WORD_SEQUENCE) {
    const merged = [];

    for (const file of WORD_FILES[length]) {
      const data = await fetchWordFile(file);
      merged.push(...data);
    }

    const cleaned = [...new Set(
      merged
        .map(normalize)
        .filter((word) => charLength(word) === length)
        .filter((word) => /^[a-zäöüß]+$/i.test(word))
    )];

    if (!cleaned.length) {
      throw new Error(`Wortliste für ${length} Buchstaben ist leer.`);
    }

    loaded[length] = cleaned;
  }

  WORDS = loaded;
}


function usernameToEmail(username) {
  const cleaned = String(username || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]/g, "");

  return `${cleaned}@worttiger.example.com`;
}




function setAuthStatus(message) {
  const el = document.getElementById("authStatus");
  if (el) {
    el.textContent = message;
  }
}

function getCurrentUsername() {
  if (!appState.currentUser) return null;

  return (
    appState.currentUser.user_metadata?.username ||
    appState.currentUser.email?.split("@")[0] ||
    null
  );
}

function resetUserStats() {
  appState.userStats = {
    currentStreak: 0,
    bestStreak: 0,
  };
}

async function ensureUserStatsRow(userId) {
  if (!userId) return;

  const { data, error } = await sb
    .from("user_stats")
    .select("user_id")
    .eq("user_id", userId)
    .maybeSingle();

  if (error) {
    console.error("ensureUserStatsRow select error:", error);
    return;
  }

  if (data) {
    return;
  }

  const { error: insertError } = await sb.from("user_stats").insert({
    user_id: userId,
    current_streak: 0,
    best_streak: 0,
    updated_at: new Date().toISOString(),
  });

  if (insertError) {
    console.error("ensureUserStatsRow insert error:", insertError);
  }
}

async function loadUserStats(userId = appState.currentUser?.id) {
  if (!userId) {
    resetUserStats();
    render();
    return;
  }

  await ensureUserStatsRow(userId);

  const { data, error } = await sb
    .from("user_stats")
    .select("current_streak, best_streak")
    .eq("user_id", userId)
    .single();

  if (error) {
    console.error("loadUserStats error:", error);
    resetUserStats();
    render();
    return;
  }

  if (appState.currentUser?.id !== userId) {
    return;
  }

  appState.userStats = {
    currentStreak: Number(data?.current_streak || 0),
    bestStreak: Number(data?.best_streak || 0),
  };

  render();
}

async function saveUserStats(userId = appState.currentUser?.id) {
  if (!userId) return;

  const { error } = await sb.from("user_stats").upsert(
    {
      user_id: userId,
      current_streak: appState.userStats.currentStreak,
      best_streak: appState.userStats.bestStreak,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "user_id" }
  );

  if (error) {
    console.error("saveUserStats error:", error);
  }
}

async function registerSolvedRoundForStreak() {
  const userId = appState.currentUser?.id;
  if (!userId) return;

  appState.userStats.currentStreak += 1;

  if (appState.userStats.currentStreak > appState.userStats.bestStreak) {
    appState.userStats.bestStreak = appState.userStats.currentStreak;
  }

  await saveUserStats(userId);
  render();
}

async function registerFailedRoundForStreak() {
  const userId = appState.currentUser?.id;
  if (!userId) return;

  appState.userStats.currentStreak = 0;
  await saveUserStats(userId);
  render();
}

async function refreshCurrentUser() {
  setAuthStatus("Nicht eingeloggt");
  appState.currentUser = null;
  appState.userStats = {
    currentStreak: 0,
    bestStreak: 0,
  };

  const { data, error } = await sb.auth.getUser();

  if (error) {
    const message = String(error.message || "").toLowerCase();

    if (!message.includes("auth session missing")) {
      console.error("getUser error:", error);
    }

    setAuthStatus("Nicht eingeloggt");
    return null;
  }

  const user = data?.user || null;

  if (!user) {
    setAuthStatus("Nicht eingeloggt");
    return null;
  }

  appState.currentUser = user;
  await loadUserStats(user.id);

  const username =
    user.user_metadata?.username ||
    user.email?.split("@")[0] ||
    "Benutzer";

  setAuthStatus(`Eingeloggt als ${username}`);
  return user;
}

async function registerWithEmail() {
  const username = document.getElementById("usernameInput").value.trim();
  const password = document.getElementById("passwordInput").value;

  if (!username || !password) {
    setAuthStatus("Bitte Benutzername und Passwort eingeben.");
    return;
  }

  const { data, error } = await sb.functions.invoke("register-user", {
    body: { username, password },
  });

  if (error) {
    console.error(error);
    setAuthStatus(`Registrierung fehlgeschlagen: ${error.message}`);
    return;
  }

  if (data?.error) {
    setAuthStatus(`Registrierung fehlgeschlagen: ${data.error}`);
    return;
  }

  setAuthStatus(`Registriert als ${username}. Jetzt bitte einloggen.`);
}

async function loginWithEmail() {
  const username = document.getElementById("usernameInput").value.trim();
  const password = document.getElementById("passwordInput").value;

  if (!username || !password) {
    setAuthStatus("Bitte Benutzername und Passwort eingeben.");
    return;
  }

  const email = usernameToEmail(username);

  const { data, error } = await sb.auth.signInWithPassword({
    email,
    password,
  });

  if (error) {
    console.error(error);
    setAuthStatus(`Login fehlgeschlagen: ${error.message}`);
    return;
  }

  appState.currentUser = data.user || null;
  loadUserStats();
  setAuthStatus(`Eingeloggt als ${username}`);
}

async function logoutUser() {
  const { error } = await sb.auth.signOut();

  if (error) {
    console.error(error);
    setAuthStatus(`Logout fehlgeschlagen: ${error.message}`);
    return;
  }

  appState.currentUser = null;
  resetUserStats();
  setAuthStatus("Nicht eingeloggt");
  render();
}


sb.auth.onAuthStateChange((_event, session) => {
  const user = session?.user || null;

  if (!user) {
    appState.currentUser = null;
    resetUserStats();
    setAuthStatus("Nicht eingeloggt");
    if (WORDS && appState.boards && Object.keys(appState.boards).length) {
      render();
    }
    return;
  }

  appState.currentUser = user;

  const username =
    user.user_metadata?.username ||
    user.email?.split("@")[0] ||
    "Benutzer";

  setAuthStatus(`Eingeloggt als ${username}`);

  const stableUserId = user.id;
  Promise.resolve().then(() => loadUserStats(stableUserId));
});

function newGameState() {
  clearRevealTimers();

  appState.sequenceIndex = 0;
  appState.solutions = {};
  appState.boards = {};
  appState.keyboard = {};
  appState.isAwaitingContinue = false;
  appState.currentWordCompletedAt = null;
  appState.completedWords = [];
  appState.gameFinished = false;
  appState.gameStartedAt = nowMs();
  appState.activeWordStartedAt = nowMs();
  appState.viewingLength = WORD_SEQUENCE[0];
  appState.cursorIndex = 0;

  for (const length of WORD_SEQUENCE) {
    appState.solutions[length] = normalize(randomChoice(WORDS[length]));
    appState.boards[length] = createEmptyBoard(length);
  }
}

function startNewGame(incrementGameNumber = false) {
  if (incrementGameNumber) {
    appState.gameNumber += 1;
  }

  newGameState();
  setStatus(`Spiel ${appState.gameNumber} gestartet. Los geht's mit ${getCurrentLength()} Buchstaben.`);
  render();
  updateTimers();
  saveLocalProgress();
  startTimerLoop();
}

function setKeyboardState(char, nextState) {
  const current = appState.keyboard[char] || "unknown";
  if (STATE_RANK[nextState] > STATE_RANK[current]) {
    appState.keyboard[char] = nextState;
  }
}

function evaluateGuess(guess, solution) {
  const guessChars = [...guess];
  const solutionChars = [...solution];
  const result = Array(guessChars.length).fill("absent");
  const used = Array(solutionChars.length).fill(false);

  for (let i = 0; i < guessChars.length; i++) {
    if (guessChars[i] === solutionChars[i]) {
      result[i] = "correct";
      used[i] = true;
    }
  }

  for (let i = 0; i < guessChars.length; i++) {
    if (result[i] === "correct") continue;

    for (let j = 0; j < solutionChars.length; j++) {
      if (!used[j] && guessChars[i] === solutionChars[j]) {
        result[i] = "present";
        used[j] = true;
        break;
      }
    }
  }

  return result;
}

function runRevealAnimation(length, rowIndex, onComplete) {
  clearRevealTimers();
  appState.isRevealing = true;
  appState.revealState = {
    length,
    rowIndex,
    revealedCount: 0,
  };
  render();

  const stepMs = 260;

  for (let i = 0; i < length; i++) {
    const timeoutId = setTimeout(() => {
      appState.revealState = {
        length,
        rowIndex,
        revealedCount: i + 1,
      };
      render();
    }, i * stepMs);

    revealTimeouts.push(timeoutId);
  }

  const finishId = setTimeout(() => {
    appState.isRevealing = false;
    appState.revealState = null;
    revealTimeouts = [];
    render();
    if (typeof onComplete === "function") {
      onComplete();
    }
  }, length * stepMs + 120);

  revealTimeouts.push(finishId);
}

function calculatePoints(attemptsUsed, solved) {
  if (!solved) return 0;
  return Math.max(0, MAX_POINTS_PER_WORD - (attemptsUsed - 1) * POINTS_LOST_PER_ATTEMPT);
}

function finishGame(won) {
  appState.isAwaitingContinue = false;
  appState.currentWordCompletedAt = null;
  appState.gameFinished = true;
  appState.viewingLength = getCurrentLength();

  stopTimerLoop();
  persistFinishedGame(won);

  if (won) {
    setStatus("Alle 4 Runden sind abgeschlossen.", "Spiel beendet");
  } else {
    setStatus("Alle 4 Runden sind abgeschlossen.", "Spiel beendet");
  }

  render();
  saveLocalProgress();
}

async function finalizeSolvedWord() {
  const length = getCurrentLength();
  const board = getCurrentBoard();
  const wordElapsedMs = nowMs() - appState.activeWordStartedAt;
  const points = calculatePoints(board.guesses.length, true);

  const stats = {
    length,
    solution: appState.solutions[length],
    attemptsUsed: board.guesses.length,
    points,
    wordElapsedMs,
    solved: true,
  };

  board.stats = stats;
  appState.completedWords.push(stats);
  await registerSolvedRoundForStreak();
  appState.currentWordCompletedAt = nowMs();
  appState.viewingLength = length;

  if (appState.sequenceIndex === WORD_SEQUENCE.length - 1) {
    finishGame(true);
    return;
  }

  appState.isAwaitingContinue = true;
  setStatus("Runde erfolgreich abgeschlossen. Klicke auf Weiter.", displayWord(stats.solution));
  render();
  saveLocalProgress();
}

async function finalizeFailedWord() {
  const length = getCurrentLength();
  const board = getCurrentBoard();
  const wordElapsedMs = nowMs() - appState.activeWordStartedAt;

  const stats = {
    length,
    solution: appState.solutions[length],
    attemptsUsed: ATTEMPTS,
    points: 0,
    wordElapsedMs,
    solved: false,
  };

  board.stats = stats;
  appState.completedWords.push(stats);
  await registerFailedRoundForStreak();
  appState.currentWordCompletedAt = nowMs();
  appState.viewingLength = length;

  if (appState.sequenceIndex === WORD_SEQUENCE.length - 1) {
    finishGame(false);
    return;
  }

  appState.isAwaitingContinue = true;
  setStatus("Runde nicht geschafft. Klicke auf Weiter.", displayWord(stats.solution));
  render();
  saveLocalProgress();
}

function submitGuess() {
  if (appState.isAwaitingContinue || appState.gameFinished || appState.isRevealing || !isViewingCurrentBoard()) return;

  const length = getCurrentLength();
  const board = getCurrentBoard();
  const guess = currentGuessString(board);

  if (!isCurrentGuessComplete(board)) {
    setStatus(`Bitte alle ${length} Buchstaben ausfüllen.`);
    return;
  }

  if (charLength(guess) !== length) {
    setStatus(`Bitte genau ${length} Buchstaben eingeben.`);
    return;
  }

  if (!WORDS[length].includes(guess)) {
    setInvalidWordStatus(guess);
    return;
  }

  const solution = appState.solutions[length];
  const evaluation = evaluateGuess(guess, solution);
  const rowIndex = board.guesses.length;

  board.guesses.push(guess);
  board.evaluations.push(evaluation);
  board.currentTiles = Array(length).fill("");
  appState.cursorIndex = 0;

  [...guess].forEach((char, index) => {
    setKeyboardState(char, evaluation[index]);
  });

  runRevealAnimation(length, rowIndex, async () => {
    if (guess === solution) {
      board.solved = true;
      await finalizeSolvedWord();
      return;
    }

    if (board.guesses.length >= ATTEMPTS) {
      board.failed = true;
      await finalizeFailedWord();
      return;
    }

    setStatus(`${ATTEMPTS - board.guesses.length} Versuch(e) übrig für ${length} Buchstaben.`);
    render();
    saveLocalProgress();
  });
}

function continueAfterRound() {
  if (!appState.isAwaitingContinue) return;

  if (appState.sequenceIndex < WORD_SEQUENCE.length - 1) {
    appState.sequenceIndex += 1;
    appState.isAwaitingContinue = false;
    appState.currentWordCompletedAt = null;
    appState.activeWordStartedAt = nowMs();
    appState.keyboard = {};
    appState.viewingLength = getCurrentLength();
    appState.cursorIndex = 0;

    setStatus(`Weiter geht's mit ${getCurrentLength()} Buchstaben.`);
    render();
    saveLocalProgress();
  }
}

function handleCharInput(char) {
  if (appState.isAwaitingContinue || appState.gameFinished || appState.isRevealing || !isViewingCurrentBoard()) return;

  const board = getCurrentBoard();
  if (!board || board.solved || board.failed) return;
  if (appState.cursorIndex >= board.length) return;

  const nextChar = normalizeChar(char);
  if (!nextChar) return;

  board.currentTiles[appState.cursorIndex] = nextChar;

  if (appState.cursorIndex < board.length - 1) {
    appState.cursorIndex += 1;
  } else {
    appState.cursorIndex = board.length;
  }

  render();
  saveLocalProgress();
}

function removeLastChar() {
  if (appState.isAwaitingContinue || appState.gameFinished || appState.isRevealing || !isViewingCurrentBoard()) return;

  const board = getCurrentBoard();
  if (!board || board.solved || board.failed) return;

  if (appState.cursorIndex > 0 && appState.cursorIndex <= board.length) {
    const targetIndex =
      appState.cursorIndex === board.length || !board.currentTiles[appState.cursorIndex]
        ? appState.cursorIndex - 1
        : appState.cursorIndex;

    if (targetIndex >= 0) {
      board.currentTiles[targetIndex] = "";
      appState.cursorIndex = targetIndex;
    }
  }

  render();
  saveLocalProgress();
}

function revealCurrentSolution() {
  const length = getCurrentLength();
  const solution = appState.solutions[length];
  setStatus(`Aktuelle Lösung (${length} Buchstaben)`, displayWord(solution));
}

function giveUpCurrentRound() {
  if (appState.isAwaitingContinue || appState.gameFinished || appState.isRevealing || !isViewingCurrentBoard()) {
    return;
  }

  const board = getCurrentBoard();
  if (!board || board.solved || board.failed) return;

  const confirmed = window.confirm("Wirklich aufgeben?");
  if (!confirmed) return;

  board.failed = true;
  board.currentTiles = Array(board.length).fill("");
  appState.cursorIndex = 0;

  finalizeFailedWord();
}


function persistFinishedGame(won) {
  const gameElapsedMs = nowMs() - appState.gameStartedAt;

  const payload = {
    gameNumber: appState.gameNumber,
    finishedAt: new Date().toISOString(),
    won,
    gameElapsedMs,
    totalPoints: appState.completedWords.reduce((sum, item) => sum + item.points, 0),
    words: appState.completedWords.map((item) => ({
      length: item.length,
      solution: item.solution,
      attemptsUsed: item.attemptsUsed,
      points: item.points,
      wordElapsedMs: item.wordElapsedMs,
      solved: item.solved,
    })),
  };

  const history = JSON.parse(localStorage.getItem("worttiger_game_history") || "[]");
  history.unshift(payload);

  const trimmed = history.slice(0, HISTORY_LIMIT);
  localStorage.setItem("worttiger_game_history", JSON.stringify(trimmed));
  appState.gameHistory = trimmed;
}

function saveLocalProgress() {
  const payload = {
    gameNumber: appState.gameNumber,
    sequenceIndex: appState.sequenceIndex,
    solutions: appState.solutions,
    boards: appState.boards,
    keyboard: appState.keyboard,
    isAwaitingContinue: appState.isAwaitingContinue,
    activeWordStartedAt: appState.activeWordStartedAt,
    gameStartedAt: appState.gameStartedAt,
    currentWordCompletedAt: appState.currentWordCompletedAt,
    completedWords: appState.completedWords,
    gameFinished: appState.gameFinished,
    viewingLength: appState.viewingLength,
    cursorIndex: appState.cursorIndex,
    savedAt: new Date().toISOString(),
  };

  localStorage.setItem("worttiger_state", JSON.stringify(payload));
}

function loadGameHistory() {
  appState.gameHistory = JSON.parse(localStorage.getItem("worttiger_game_history") || "[]");
}

function loadLocalProgress() {
  loadGameHistory();

  const raw = localStorage.getItem("worttiger_state");
  if (!raw) {
    startNewGame(false);
    return;
  }

  try {
    const payload = JSON.parse(raw);

    appState.gameNumber = payload.gameNumber || 1;
    appState.sequenceIndex = payload.sequenceIndex || 0;
    appState.solutions = payload.solutions || {};
    appState.boards = {};

    for (const length of WORD_SEQUENCE) {
      appState.boards[length] = normalizeLoadedBoard(payload.boards?.[length], length);
    }

    appState.keyboard = payload.keyboard || {};
    appState.isAwaitingContinue = Boolean(payload.isAwaitingContinue);
    appState.activeWordStartedAt = payload.activeWordStartedAt || nowMs();
    appState.gameStartedAt = payload.gameStartedAt || nowMs();
    appState.currentWordCompletedAt = payload.currentWordCompletedAt || null;
    appState.completedWords = payload.completedWords || [];
    appState.gameFinished = Boolean(payload.gameFinished);
    appState.viewingLength = payload.viewingLength || getCurrentLength();
    appState.cursorIndex = payload.cursorIndex || 0;
    appState.isRevealing = false;
    appState.revealState = null;

    if (!appState.solutions[getCurrentLength()] || !appState.boards[getCurrentLength()]) {
      throw new Error("Unvollständiger Spielstand");
    }

    syncCursorIndex();
    setStatus(`Lokaler Spielstand geladen. Aktuell: ${getCurrentLength()} Buchstaben.`);
    render();
    updateTimers();

    if (!appState.gameFinished) {
      startTimerLoop();
    }
  } catch (error) {
    console.error(error);
    localStorage.removeItem("worttiger_state");
    startNewGame(false);
  }
}

function isRevealRow(length, rowIndex) {
  return Boolean(
    appState.revealState &&
    appState.revealState.length === length &&
    appState.revealState.rowIndex === rowIndex
  );
}

function renderBoard() {
  const board = getViewedBoard();
  const length = getViewedLength();
  const actualCurrentLength = getCurrentLength();
  const container = document.getElementById("board");

  if (!container) return;

  if (!board) {
    container.innerHTML = "";
    document.getElementById("boardTitle").textContent = "Aktuelles Wort";
    document.getElementById("boardSubtitle").textContent = "Lade Spielstand ...";
    document.getElementById("gameInfo").textContent = "";
    return;
  }

  container.innerHTML = "";
  const tileSize = window.innerWidth <= 640 ? 58 : 72;
  const tileGap = window.innerWidth <= 640 ? 6 : 8;
  const boardWidth = length * tileSize + (length - 1) * tileGap;

  container.style.width = `${boardWidth}px`;
  container.style.maxWidth = "100%";

  const viewingCurrent = isViewingCurrentBoard();

  document.getElementById("boardTitle").textContent = `${length}-Buchstaben-Wort`;
  document.getElementById("boardSubtitle").textContent = viewingCurrent
    ? `${ATTEMPTS} Versuche · ${appState.isAwaitingContinue ? "Runde beendet" : appState.gameFinished ? "Spiel beendet" : "aktiv"}`
    : `Abgeschlossenes Brett · aktuell offen: ${actualCurrentLength} Buchstaben`;

  document.getElementById("gameInfo").textContent =
    `Spiel ${appState.gameNumber} · Ansicht ${WORD_SEQUENCE.indexOf(length) + 1}/4`;

  for (let rowIndex = 0; rowIndex < ATTEMPTS; rowIndex++) {
    const row = document.createElement("div");
    row.className = "row";
    row.style.gridTemplateColumns = `repeat(${length}, 1fr)`;

    const guessChars =
      board.guesses[rowIndex]
        ? [...board.guesses[rowIndex]]
        : viewingCurrent && rowIndex === board.guesses.length
        ? board.currentTiles
        : Array(length).fill("");

    const evaluation = board.evaluations[rowIndex] || [];
    const revealRow = isRevealRow(length, rowIndex);
    const revealedCount = revealRow ? appState.revealState.revealedCount : length;

    const activeRow =
      viewingCurrent &&
      rowIndex === board.guesses.length &&
      !board.solved &&
      !board.failed &&
      !appState.isAwaitingContinue &&
      !appState.gameFinished &&
      !appState.isRevealing;

    for (let i = 0; i < length; i++) {
      const tile = document.createElement("div");
      tile.className = "tile";

      const char = guessChars[i] || "";
      tile.textContent = displayChar(char);

      if (char) tile.classList.add("filled");

      const shouldShowEvaluation = evaluation[i] && i < revealedCount;
      if (shouldShowEvaluation) {
        tile.classList.add(evaluation[i]);
      }

      if (revealRow && i === revealedCount - 1) {
        tile.classList.add("reveal");
      }

      if (activeRow && i === appState.cursorIndex && appState.cursorIndex < length) {
        tile.classList.add("active");
      }

      if (viewingCurrent && activeRow) {
        tile.classList.add("clickable");
        tile.addEventListener("click", () => setCursorIndex(i));
      }

      row.appendChild(tile);
    }

    if (viewingCurrent && activeRow && appState.cursorIndex === length) {
      const tiles = row.querySelectorAll(".tile");
      if (tiles[length - 1]) {
        tiles[length - 1].classList.add("active");
      }
    }

    container.appendChild(row);
  }
}

function renderContinueArea() {
  const button = document.getElementById("continueBtn");
  const result = document.getElementById("wordResult");
  const currentBoard = getCurrentBoard();

  button.classList.toggle("visible", appState.isAwaitingContinue || appState.gameFinished);
  button.textContent = appState.gameFinished ? "Neues Spiel" : "Weiter";

  if (appState.gameFinished) {
    const totalPoints = appState.completedWords.reduce((sum, item) => sum + item.points, 0);
    const solvedRounds = appState.completedWords.filter((item) => item.solved).length;
    const totalTimeMs = nowMs() - appState.gameStartedAt;

    result.classList.add("visible");
    result.innerHTML = `
      <h3>Spiel abgeschlossen</h3>
      <div class="result-grid">
        <div class="stat-card">
          <small>Gesamtpunkte</small>
          <strong>${totalPoints}</strong>
        </div>
        <div class="stat-card">
          <small>Gesamtzeit</small>
          <strong>${msToClock(totalTimeMs)}</strong>
        </div>
        <div class="stat-card">
          <small>Gelöste Runden</small>
          <strong>${solvedRounds} / 4</strong>
        </div>
        <div class="stat-card">
          <small>Aktuelle Serie</small>
          <strong>${appState.userStats.currentStreak}</strong>
        </div>
        <div class="stat-card">
          <small>Beste Serie</small>
          <strong>${appState.userStats.bestStreak}</strong>
        </div>
      </div>
    `;
    return;
  }

  if (appState.isAwaitingContinue && currentBoard?.stats) {
    const totalPoints = appState.completedWords.reduce((sum, item) => sum + item.points, 0);
    const roundText = currentBoard.stats.solved ? "Runde geschafft" : "Runde nicht geschafft";

    result.classList.add("visible");
    result.innerHTML = `
      <h3>${roundText}: ${displayWord(currentBoard.stats.solution)}</h3>
      <div class="result-grid">
        <div class="stat-card">
          <small>Zeit für diese Runde</small>
          <strong>${msToClock(currentBoard.stats.wordElapsedMs)}</strong>
        </div>
        <div class="stat-card">
          <small>Versuche</small>
          <strong>${currentBoard.stats.attemptsUsed}</strong>
        </div>
        <div class="stat-card">
          <small>Punkte</small>
          <strong>${currentBoard.stats.points}</strong>
        </div>
        <div class="stat-card">
          <small>Spielpunkte gesamt</small>
          <strong>${totalPoints}</strong>
        </div>
      </div>
    `;
    return;
  }

  result.classList.remove("visible");
  result.innerHTML = "";
}

function renderKeyboard() {
  const keyboard = document.getElementById("keyboard");
  keyboard.innerHTML = "";

  const disableKeyboard =
    appState.isAwaitingContinue ||
    appState.gameFinished ||
    appState.isRevealing ||
    !isViewingCurrentBoard();

  KEYBOARD_ROWS.forEach((rowChars) => {
    const row = document.createElement("div");
    row.className = "key-row";

    rowChars.forEach((char) => {
      const key = document.createElement("button");
      key.className = "key";
      if (window.innerWidth > 640 && (char === "enter" || char === "backspace")) {
        key.classList.add("wide");
      }

      key.textContent =
        char === "backspace" ? "⌫" :
        char === "enter" ? "⏎" :
        displayChar(char);
      const state = appState.keyboard[char];
      if (state) key.classList.add(state);

      key.disabled = disableKeyboard;
      key.addEventListener("click", () => handleVirtualKey(char));
      row.appendChild(key);
    });

    keyboard.appendChild(row);
  });
}

function renderSteps() {
  const steps = document.getElementById("steps");
  steps.innerHTML = "";

  WORD_SEQUENCE.forEach((length, index) => {
    const board = appState.boards[length];
    const item = document.createElement("button");
    item.type = "button";
    item.className = "step";

    if (length === getViewedLength()) {
      item.classList.add("active");
    }

    if (board?.solved) {
      item.classList.add("done");
    }

    const label = board?.solved
      ? `gelöst in ${board.stats?.attemptsUsed || "-"} Versuch(en)`
      : board?.failed
      ? "nicht geschafft"
      : index < appState.sequenceIndex
      ? "fertig"
      : index === appState.sequenceIndex
      ? "aktuell"
      : "offen";

    item.innerHTML = `
      <div>
        <strong>${length} Buchstaben</strong><br>
        <span class="muted">${label}</span>
      </div>
      <span class="badge">${index + 1}</span>
    `;

    item.addEventListener("click", () => openBoard(length));
    steps.appendChild(item);
  });
}

function renderCurrentGameSummary() {
  const target = document.getElementById("currentGameSummary");
  target.innerHTML = "";

  const username = getCurrentUsername();

  const streakDiv = document.createElement("div");
  streakDiv.className = "summary-item good";
  streakDiv.innerHTML = `
    <strong>Serie${username ? ` · ${escapeHtml(username)}` : ""}</strong>
    <div class="muted">
      Aktuelle Serie: ${appState.userStats.currentStreak} Runde(n) ·
      Beste Serie: ${appState.userStats.bestStreak} Runde(n)
    </div>
  `;
  target.appendChild(streakDiv);

  if (!appState.completedWords.length) {
    const empty = document.createElement("p");
    empty.className = "empty";
    empty.textContent = "Noch keine abgeschlossenen Runden in diesem Spiel.";
    target.appendChild(empty);
    return;
  }

  appState.completedWords.forEach((item) => {
    const div = document.createElement("div");
    div.className = `summary-item ${item.solved ? "good" : "bad"}`;
    div.innerHTML = `
      <strong>${item.length} Buchstaben · ${displayWord(item.solution)}</strong>
      <div class="muted">Zeit: ${msToClock(item.wordElapsedMs)} · Versuche: ${item.attemptsUsed} · Punkte: ${item.points}</div>
    `;
    target.appendChild(div);
  });
}

function renderHistory() {
  const target = document.getElementById("historyList");
  target.innerHTML = "";

  if (!appState.gameHistory.length) {
    target.innerHTML = '<p class="empty">Noch keine gespeicherten Spiele.</p>';
    return;
  }

  appState.gameHistory.slice(0, HISTORY_LIMIT).forEach((game) => {
    const div = document.createElement("div");
    div.className = "history-item";
    const wordsLine = game.words
      .map((item) => `${item.length}: ${displayWord(item.solution)} (${item.points} P)`)
      .join(" · ");

    div.innerHTML = `
      <strong>Spiel ${game.gameNumber}</strong>
      <div class="muted">Gesamtzeit: ${msToClock(game.gameElapsedMs)} · Gesamtpunkte: ${game.totalPoints}</div>
      <div class="muted" style="margin-top: 6px;">${wordsLine}</div>
    `;

    target.appendChild(div);
  });
}

function render() {
  if (!WORDS) return;

  renderBoard();
  renderContinueArea();
  renderKeyboard();
  renderSteps();
  renderCurrentGameSummary();
  renderHistory();
  updateTimers();
}

function handleVirtualKey(key) {
  if (key === "enter") {
    if (appState.isAwaitingContinue) return continueAfterRound();
    if (appState.gameFinished) return startNewGame(true);
    return submitGuess();
  }

  if (key === "backspace") return removeLastChar();
  handleCharInput(key);
}

document.addEventListener("keydown", (event) => {
  const target = event.target;
  const tagName = target?.tagName?.toLowerCase();

  const isTypingInField =
    tagName === "input" ||
    tagName === "textarea" ||
    tagName === "select" ||
    target?.isContentEditable;

  if (isTypingInField) {
    return;
  }

  if (appState.isRevealing) {
    return;
  }

  if (appState.isAwaitingContinue) {
    if (event.key === "Enter") {
      event.preventDefault();
      continueAfterRound();
    }
    return;
  }

  if (appState.gameFinished) {
    if (event.key === "Enter") {
      event.preventDefault();
      startNewGame(true);
    }
    return;
  }

  if (!isViewingCurrentBoard()) return;

  if (event.key === "Enter") {
    event.preventDefault();
    submitGuess();
    return;
  }

  if (event.key === "Backspace") {
    event.preventDefault();
    removeLastChar();
    return;
  }

  if (event.key === "ArrowLeft") {
    event.preventDefault();
    setCursorIndex(appState.cursorIndex - 1);
    return;
  }

  if (event.key === "ArrowRight") {
    event.preventDefault();
    setCursorIndex(appState.cursorIndex + 1);
    return;
  }

  const normalized = normalize(event.key);
  if (/^[a-zäöüß]$/i.test(normalized)) {
    event.preventDefault();
    handleCharInput(normalized);
  }
});


document.getElementById("registerBtn").addEventListener("click", registerWithEmail);
document.getElementById("loginBtn").addEventListener("click", loginWithEmail);
document.getElementById("logoutBtn").addEventListener("click", logoutUser);


document.getElementById("newGameBtn").addEventListener("click", () => startNewGame(true));
document.getElementById("giveUpBtn").addEventListener("click", giveUpCurrentRound);
document.getElementById("continueBtn").addEventListener("click", () => {
  if (appState.gameFinished) {
    startNewGame(true);
    return;
  }
  continueAfterRound();
});

(async function init() {
  try {
    await loadWordLists();
    loadLocalProgress();
    await refreshCurrentUser();
    setStatus(`Wortlisten geladen. Aktuell: ${getCurrentLength()} Buchstaben.`);
    render();
  } catch (error) {
    console.error(error);
    setStatus(`Fehler beim Laden: ${error.message}`);
  }
})();

async function testSupabase() {
  const { data, error } = await sb.from("games").select("*");

  console.log("Supabase Test:", data, error);
}

// testSupabase();