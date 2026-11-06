/** R2 is shared by all tests in a file, and keys now come from the text, so each test starts from an empty bucket. */
export async function resetBucket(bucket: R2Bucket): Promise<void> {
  const { objects } = await bucket.list();
  if (objects.length > 0) await bucket.delete(objects.map((o) => o.key));
}
