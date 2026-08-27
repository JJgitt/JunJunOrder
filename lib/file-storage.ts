import path from "node:path";

export function uploadRoot(){return process.env.UPLOAD_DIR?path.resolve(process.env.UPLOAD_DIR):path.resolve("data/uploads");}

export function uploadPath(objectKey:string){
  const root=uploadRoot();
  const target=path.resolve(root,...objectKey.split("/"));
  if(target!==root&&!target.startsWith(`${root}${path.sep}`))throw new Error("文件路径无效");
  return target;
}

export function imageExtension(contentType:string){
  const extensions:Record<string,string>={"image/jpeg":".jpg","image/png":".png","image/webp":".webp","image/gif":".gif","image/heic":".heic","image/heif":".heif"};
  return extensions[contentType]??null;
}
