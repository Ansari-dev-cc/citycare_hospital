# Hospital booking (Node.js + Express + MySQL)

## Run locally
1. Create the DB:  mysql -u root -p < schema.sql
2. cp .env.example .env   (edit DB values)
3. npm install && npm start  ->  http://localhost:3000

## Deploy to Azure
1. Azure Database for MySQL Flexible Server -> run schema.sql (Cloud Shell or MySQL Workbench).
2. Azure App Service (Linux, Node 20 LTS). In Settings > Environment variables add:
   DB_HOST, DB_USER, DB_PASSWORD, DB_NAME=hospital, DB_SSL=true
3. Allow App Service to reach MySQL (Networking > allow Azure services, or use VNet integration).
4. Deploy: az webapp up --name <unique-name> --resource-group <rg> --runtime "NODE:20-lts" --sku B1
5. Test: https://<unique-name>.azurewebsites.net/api/health
