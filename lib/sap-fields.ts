// The built-in mock rules: SAP's standard field names, as RAP and CDS APIs spell them
// (PurchaseOrder) and as classic Gateway services do, by their DDIC names (Ebeln), with
// numbers in SAP's standard ranges (S/4HANA Best Practices). Same format as config.json's
// "mock" (see config.ts): any entry can be copied there and changed.
//
// They come last: config.json and what it extends win. A built-in rule that doesn't fit a
// property is skipped, and a running number is only for a number, or a text of at most 12
// (an ID, not a name: a Supplier of 100 is a company's name). A key named ID, Id, Number or
// Key is matched by its entity type's name: PurchaseOrder.ID by "PurchaseOrder" (see
// resolveMockRules in mock-rules.ts).

const SAP_FIELDS: Record<string, string> = {
  // Purchase order and its items
  PurchaseOrder: "45########",
  PurchaseOrderId: "45########",
  Ebeln: "45########",
  PurchaseOrderItem: "####0",
  Ebelp: "####0",
  // Purchase requisition
  PurchaseRequisition: "001#######",
  PurchaseRequisitionId: "001#######",
  Banfn: "001#######",
  // Sales order and its items
  SalesOrder: "000#######",
  SalesOrderId: "000#######",
  Vbeln: "000#######",
  SalesOrderItem: "#####0",
  Posnr: "#####0",
  // Outbound delivery, billing document, material document
  OutboundDelivery: "008#######",
  DeliveryDocument: "008#######",
  BillingDocument: "009#######",
  MaterialDocument: "49########",
  Mblnr: "49########",
  // Business partners and materials, where they're IDs
  Supplier: "173#####",
  SupplierId: "173#####",
  Lifnr: "173#####",
  Customer: "171#####",
  CustomerId: "171#####",
  Kunnr: "171#####",
  Material: "TG##",
  MaterialId: "TG##",
  Matnr: "TG##",
};

export { SAP_FIELDS };
