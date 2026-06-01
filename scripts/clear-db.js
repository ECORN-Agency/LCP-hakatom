import prisma from "../app/db.server.js";

async function clearDatabase() {
  try {
    console.log("Clearing Change table...");
    const deletedChanges = await prisma.change.deleteMany({});
    console.log(`Deleted ${deletedChanges.count} changes`);

    try {
      console.log("Clearing MetricBucket table...");
      const deletedMetrics = await prisma.metricBucket.deleteMany({});
      console.log(`Deleted ${deletedMetrics.count} metrics`);
    } catch (error) {
      if (error.code === "P2021") {
        console.log("MetricBucket table does not exist yet, skipping...");
      } else {
        throw error;
      }
    }

    console.log("Database cleared successfully!");
  } catch (error) {
    console.error("Error clearing database:", error);
    throw error;
  } finally {
    await prisma.$disconnect();
  }
}

clearDatabase();

