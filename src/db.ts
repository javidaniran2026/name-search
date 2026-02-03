import { MongoClient, Db } from "mongodb";

const MONGO_URI = process.env.MONGO_URI ?? "mongodb://localhost:27017/namesearch";

let client: MongoClient | null = null;

export async function connectDb(): Promise<Db> {
  if (client) return client.db();
  client = new MongoClient(MONGO_URI);
  await client.connect();
  return client.db();
}

export async function closeDb(): Promise<void> {
  if (client) {
    await client.close();
    client = null;
  }
}

export async function ensureIndexes(db: Db): Promise<void> {
  const coll = db.collection("victims");
  await coll.createIndex({ normalizedName: 1 });
  await coll.createIndex({ normalizedLocation: 1 });
  await coll.createIndex({ date: 1 });
  await coll.createIndex({ messageId: 1 }, { unique: true });
}
