import { initializeApp } from 'firebase/app';
import { getFirestore } from 'firebase/firestore';
import { getAuth } from 'firebase/auth';
import { getAnalytics } from 'firebase/analytics';

const firebaseConfig = {
  apiKey: "AIzaSyBC9TKA8shfMD64qfQPJJ3DvdC7hbkxamc",
  authDomain: "performer-2df35.firebaseapp.com",
  projectId: "performer-2df35",
  storageBucket: "performer-2df35.firebasestorage.app",
  messagingSenderId: "675939098704",
  appId: "1:675939098704:web:68fd4051754f7b896ef155",
  measurementId: "G-MF7BN2MY4E"
};

const app = initializeApp(firebaseConfig);
export const db        = getFirestore(app);
export const auth      = getAuth(app);
export const analytics = getAnalytics(app);
export default app;
