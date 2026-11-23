# Used only for the Android/iOS app build (vite build --mode app).
# The address of the Everjoy server the app talks to. With an https:// address the build turns off
# plain-HTTP access and locks the app to this server (it can't be changed on the sign-in screen).
# For testing against this laptop instead, use http://<laptop Wi-Fi IP>:3001 and run `npm run demo`.
VITE_API_BASE=https://everjoy-lawndry.onrender.com
