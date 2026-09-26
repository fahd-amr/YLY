const form = document.getElementById("login-form");
const fields = document.getElementById("login-fields");
const emailInput = document.getElementById("login-email");
const passwordInput = document.getElementById("login-password");
const loginButton = document.getElementById("login-button");
const errorMessage = document.getElementById("login-error");
const statusMessage = document.getElementById("login-status");

let auth;
let signIn;
let ready = false;
let signingIn = false;
let redirecting = false;

function updateControls() {
  fields.disabled = !ready || signingIn || redirecting;
  loginButton.disabled = fields.disabled;
  loginButton.textContent = signingIn ? "Logging in…" : "Login";
  form.setAttribute("aria-busy", String(!ready || signingIn || redirecting));
}

function showError(message) {
  statusMessage.textContent = "";
  errorMessage.textContent = message;
  errorMessage.hidden = false;
  errorMessage.focus();
}

function redirectToDashboard() {
  if (redirecting) return;
  redirecting = true;
  passwordInput.value = "";
  statusMessage.textContent = "Login successful. Opening your dashboard…";
  updateControls();
  window.location.replace("index.html");
}

// Register before loading the CDN modules, so no credentials are submitted as HTML.
form.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!ready || signingIn || redirecting) return;
  emailInput.value = emailInput.value.trim();
  if (!form.reportValidity()) return;

  signingIn = true;
  errorMessage.hidden = true;
  errorMessage.textContent = "";
  statusMessage.textContent = "Logging in…";
  updateControls();
  try {
  await signIn(auth, emailInput.value, passwordInput.value);
  redirectToDashboard();
} catch (error) {
  console.error("Firebase login error:", error);
  console.error("Error code:", error.code);
  console.error("Error message:", error.message);

  if (!redirecting) {
    showError("Invalid email or password");
  }
} finally {
  signingIn = false;
  updateControls();
}
});

form.addEventListener("input", () => {
  if (!ready || signingIn || redirecting) return;
  errorMessage.hidden = true;
  errorMessage.textContent = "";
});

async function initializeLogin() {
  updateControls();
  try {
    // Dynamic imports let the page display a useful error if the CDN is offline.
    const [config, firebaseAuth] = await Promise.all([
      import("./firebase-config.js"),
      import("https://www.gstatic.com/firebasejs/9.23.0/firebase-auth.js"),
    ]);
    auth = config.auth;
    signIn = firebaseAuth.signInWithEmailAndPassword;
    firebaseAuth.onAuthStateChanged(auth, (user) => {
      if (user) {
        redirectToDashboard();
        return;
      }
      // Wait for Firebase to restore any saved session before enabling login.
      ready = true;
      if (!signingIn && !redirecting) statusMessage.textContent = "";
      updateControls();
    }, () => {
      ready = false;
      updateControls();
      showError("Login is unavailable. Reload this page and try again.");
    });
 } catch (error) {
  console.error("Firebase initialization error:", error);

  ready = false;
  updateControls();
  showError(`Firebase error: ${error.message}`);
}
}

initializeLogin();
