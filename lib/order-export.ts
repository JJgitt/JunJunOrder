import ExcelJS from "exceljs";

export type ExportOrder={id:string;platformOrderNo:string;courierNo:string};
export type ExportItem={orderId:string;title:string;size:string;qty:number;purchaseCourierNo:string};

/** Builds the compact order-list workbook. Text formatting preserves long tracking and platform numbers. */
export async function createOrdersWorkbook(orders:ExportOrder[],items:ExportItem[],createdAt:string){
  const ordersById=new Map(orders.map(order=>[order.id,order]));
  const workbook=new ExcelJS.Workbook();
  workbook.creator="JunJunOrder";
  workbook.created=new Date(createdAt);
  const sheet=workbook.addWorksheet("订单数据",{views:[{state:"frozen",ySplit:1}]});
  sheet.columns=[
    {header:"商品名",key:"title",width:28},
    {header:"尺码",key:"size",width:14},
    {header:"件数",key:"qty",width:10},
    {header:"运单号",key:"courierNo",width:24},
    {header:"订单号",key:"orderNo",width:24},
  ];
  for(const item of items){
    const order=ordersById.get(item.orderId);
    if(!order)continue;
    sheet.addRow({title:item.title,size:item.size,qty:item.qty,courierNo:item.purchaseCourierNo||order.courierNo,orderNo:order.platformOrderNo});
  }
  sheet.autoFilter={from:"A1",to:"E1"};
  const header=sheet.getRow(1);
  header.height=24;
  header.font={bold:true,color:{argb:"FFFFFFFF"}};
  header.alignment={vertical:"middle",horizontal:"center"};
  header.fill={type:"pattern",pattern:"solid",fgColor:{argb:"FF2563EB"}};
  sheet.eachRow((row,rowNumber)=>{
    if(rowNumber>1){
      row.height=22;
      row.alignment={vertical:"middle"};
    }
  });
  sheet.getColumn("qty").alignment={horizontal:"center",vertical:"middle"};
  sheet.getColumn("courierNo").numFmt="@";
  sheet.getColumn("orderNo").numFmt="@";
  const buffer=await workbook.xlsx.writeBuffer();
  return new Uint8Array(buffer);
}
