import { initializeApp } from "https://www.gstatic.com/firebasejs/9.23.0/firebase-app.js";
import { getAuth } from "https://www.gstatic.com/firebasejs/9.23.0/firebase-auth.js";
import { getFirestore } from "https://www.gstatic.com/firebasejs/9.23.0/firebase-firestore.js";

// For Firebase JS SDK v7.20.0 and later, measurementId is optional
const firebaseConfig = {
  apiKey: "AIzaSyBhXqorMLv79RoGkH11bjGqi1N8oLpVlFQ",
  authDomain: "yly-follow-up.firebaseapp.com",
  projectId: "yly-follow-up",
  storageBucket: "yly-follow-up.firebasestorage.app",
  messagingSenderId: "553634863309",
  appId: "1:553634863309:web:613c93ff7d7938c5a43184",
  measurementId: "G-J91E0XSMB0"
};

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);

export { app, auth, db };
