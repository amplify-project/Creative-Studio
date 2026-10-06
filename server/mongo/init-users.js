// Creates the two database users. Runs ONCE, when the data volume (server/data1)
// is empty — on an existing database it never runs again, so changing the
// passwords in server/.env afterwards does NOT change them in the database:
// use db.changeUserPassword (see docs/deployment.md, "Rotating the Mongo
// credentials").
//
// The passwords come from server/.env, never from this file: it used to hold
// them as literals, in a public repository.
function required(name) {
  const v = process.env[name];
  if (!v) throw new Error(`${name} must be set in server/.env`);
  return v;
}

db = db.getSiblingDB("admin");
db.createUser({
  user: "admin",
  pwd: required("MONGO_ADMIN_PASSWORD"),
  roles: [{ role: "root", db: "admin" }],
});

// The application user. DATABASE_URL carries this password.
db = db.getSiblingDB("mydb");
db.createUser({
  user: "nextauth",
  pwd: required("MONGO_APP_PASSWORD"),
  roles: [{ role: "readWrite", db: "mydb" }],
});
