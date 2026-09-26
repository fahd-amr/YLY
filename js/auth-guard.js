import { auth } from "./firebase-config.js";
import { onAuthStateChanged } from "https://www.gstatic.com/firebasejs/9.23.0/firebase-auth.js";

// Call from a protected page's module. Start its data loading only in the callback.
// This navigation guard complements the Firestore rules added during DB migration.
export function requireAuth(onAuthenticated = () => {}) {
  return onAuthStateChanged(auth, (user) => {
    if (!user) {
      window.location.replace("login.html");
      return;
    }
    onAuthenticated(user);
  }, () => {
    window.location.replace("login.html");
  });
}
