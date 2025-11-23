$env:PATH = "$PSScriptRoot\.node_portable;$env:PATH"
Write-Host "Node.js environment set up."
node -v
npm -v

if (!(Test-Path "node_modules")) {
    Write-Host "Installing dependencies..."
    npm install
}

Write-Host "Starting dev server..."
npm run dev
