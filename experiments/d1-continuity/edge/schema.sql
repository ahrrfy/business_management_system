PRAGMA foreign_keys = ON;
CREATE TABLE edge_marker(id TEXT PRIMARY KEY CHECK(id='edge-actual-20261017'), role TEXT NOT NULL CHECK(role IN('primary','restore'))) STRICT;
CREATE TABLE productPrices(id INTEGER PRIMARY KEY, productUnitId INTEGER NOT NULL CHECK(productUnitId>0), priceTier TEXT NOT NULL CHECK(priceTier IN('RETAIL','WHOLESALE','GOVERNMENT')), price TEXT NOT NULL CHECK(typeof(price)='text'), createdAt TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updatedAt TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, UNIQUE(productUnitId,priceTier)) STRICT;
CREATE TABLE storefrontCartShares(id INTEGER PRIMARY KEY, token TEXT NOT NULL UNIQUE CHECK(length(token)=24), lines TEXT NOT NULL CHECK(json_valid(lines)), expiresAt TEXT NOT NULL, createdAt TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP) STRICT;
CREATE TABLE edge_operations(id TEXT PRIMARY KEY, hash TEXT NOT NULL, result TEXT NOT NULL CHECK(json_valid(result))) STRICT;
CREATE TABLE edge_assert(ok INTEGER NOT NULL CHECK(ok=1)) STRICT;
INSERT INTO productPrices(id,productUnitId,priceTier,price) VALUES (1,1,'RETAIL','123.45'),(2,1,'WHOLESALE','100.01'),(3,2,'RETAIL','0.01'),(4,3,'RETAIL','9999999999999.99');
