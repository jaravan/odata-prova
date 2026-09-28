# The README's hero GIF. Render it from the repo root (needs vhs, jq and a free port 3000):
#   vhs img/hero.tape
# Until odata-prova is on npm, the hidden setup makes `npx odata-prova` run this repo's server.js.

Output img/hero.gif

Set Shell "bash"
Set FontSize 18
Set Width 1440
Set Height 680
Set Padding 24
Set Theme "Catppuccin Mocha"
Set WindowBar Colorful
Set BorderRadius 8
Set TypingSpeed 35ms
Set Framerate 24

# Setup, not recorded: a folder with only the metadata.xml, and npx pointed at this repo
Hide
Type "PROVA=$PWD; export PS1='$ '" Enter
Type `npx() { shift; node "$PROVA/server.js" "$@"; }` Enter
Type "rm -rf /tmp/prova-demo && mkdir -p /tmp/prova-demo/PurchaseOrderSrv" Enter
Type "cp examples/PurchaseOrderSrv/metadata.xml /tmp/prova-demo/PurchaseOrderSrv/ && cd /tmp/prova-demo && clear" Enter
Sleep 500ms
Show

# 1. Just the metadata: no code, no data
Type "ls PurchaseOrderSrv"
Sleep 400ms
Enter
Sleep 1.5s

# 2. Start it: data generated, served as V2 and V4
Type "npx odata-prova ./PurchaseOrderSrv"
Sleep 400ms
Enter
Sleep 4s

# Off camera: keep it running in the background for the requests
Hide
Ctrl+C
Sleep 300ms
Type "npx odata-prova ./PurchaseOrderSrv >/dev/null 2>&1 & sleep 1; clear" Enter
Sleep 1.5s
Show

# 3. V4: an order with its items, generated from the metadata
Type `curl -s "localhost:3000/odata/v4/PurchaseOrderSrv/PurchaseOrderSet('0000000009')?\$select=Supplier,Status&\$expand=Items(\$select=Material,Quantity)" | jq`
Sleep 400ms
Enter
Sleep 5s

Hide
Type "clear" Enter
Show

# 4. The same order over V2
Type `curl -s "localhost:3000/odata/v2/PurchaseOrderSrv/PurchaseOrderSet('0000000009')?\$select=Supplier,OrderDate,Status" | jq`
Sleep 400ms
Enter
Sleep 5s

# Stop the server
Hide
Type "kill %1" Enter
