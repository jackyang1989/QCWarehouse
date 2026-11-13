export const demoTermsVersion="demo-v1";
export const demoWarehouseAddressZh="广东省佛山市南海区桂城街道质检演示仓 3 号库";
export const usableWarehouseAddressSql=(demoParam:string,addressParam:string)=>`(${demoParam}::boolean or address_zh<>${addressParam})`;
