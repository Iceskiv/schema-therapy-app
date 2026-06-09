// Firebase: вхід через Google + синхронізація історії/ключів між пристроями.
// apiKey тут — ПУБЛІЧНИЙ ідентифікатор веб-застосунку Firebase (не секрет):
// безпеку забезпечують authorized domains + правила Firestore (кожен бачить лише свої дані).
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import {
  getAuth, GoogleAuthProvider, signInWithPopup, signOut, onAuthStateChanged,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import {
  getFirestore, doc, getDoc, setDoc, deleteDoc, collection, getDocs,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

const firebaseConfig = {
  apiKey: "AIzaSyAdDqDw7MwtJ2HP0poxoYARQXrx6T57-pw",
  authDomain: "schema-therapy-4697d.firebaseapp.com",
  projectId: "schema-therapy-4697d",
  storageBucket: "schema-therapy-4697d.firebasestorage.app",
  messagingSenderId: "218639700718",
  appId: "1:218639700718:web:767cfa4b53b368ad7199ff",
};

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);
const provider = new GoogleAuthProvider();
provider.setCustomParameters({ prompt: "select_account" });

// ---- автентифікація ----
export function onAuth(cb) { return onAuthStateChanged(auth, cb); }
export function signInGoogle() { return signInWithPopup(auth, provider); }
export function signOutUser() { return signOut(auth); }

// ---- Firestore: users/{uid} (ключі) + users/{uid}/history/{id} (знімки) ----
export async function cloudLoadAll(uid) {
  let keys = null;
  try {
    const u = await getDoc(doc(db, "users", uid));
    if (u.exists()) keys = u.data().keys || null;
  } catch {}
  const history = [];
  try {
    const snap = await getDocs(collection(db, "users", uid, "history"));
    snap.forEach((d) => history.push(d.data()));
  } catch {}
  history.sort((a, b) => (a.ts || 0) - (b.ts || 0));
  return { history, keys };
}
export function cloudPutSnapshot(uid, item) {
  return setDoc(doc(db, "users", uid, "history", item.id), item);
}
export function cloudDeleteSnapshot(uid, id) {
  return deleteDoc(doc(db, "users", uid, "history", id));
}
export function cloudSaveKeys(uid, keys) {
  return setDoc(doc(db, "users", uid), { keys }, { merge: true });
}
